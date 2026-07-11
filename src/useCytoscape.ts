/* eslint-disable @typescript-eslint/no-explicit-any -- Cytoscape's event payloads expose loosely typed data; encapsulating every variant here would add excessive boilerplate */
import { ref, shallowRef, onMounted, onBeforeUnmount, watch } from 'vue'
import cytoscape, { type Core, type NodeSingular } from 'cytoscape'
import type { GraphData, GraphEdgeData, GraphNodeData, LayoutType, RelationTypeConfig } from './types'

export interface EdgeTooltipContext {
  sourceLabel: string
  targetLabel: string
  relation: string
  relationLabel: string
  edgeData: GraphEdgeData
}

export interface DepthEffectOptions {
  /** 是否启用景深样式，默认 true */
  enabled?: boolean
  /** 缺少 depth 时，是否从中心节点自动按 BFS 推导层级，默认 true */
  autoDepth?: boolean
  /** 悬浮节点时淡化无关元素，突出一跳关系，默认 true */
  focusOnHover?: boolean
  /** 远层淡出的强度，范围 0-1，默认 0.7 */
  fadeStrength?: number
}

export interface UseCytoscapeOptions {
  graphData: GraphData
  graphVersion: number
  activeRelations: string[]
  layout: LayoutType
  showDefinitionInNode: boolean
  /** 伪 3D 景深效果配置 */
  depthEffects?: DepthEffectOptions
  /** 关系类型配置：边颜色/线型/箭头/理想边长/对称语义，由宿主注入 */
  relationTypes: RelationTypeConfig[]
  /** 节点定义提取器（用于"节点内显示定义"与悬浮提示），默认读 posDefinitions[0].definition */
  nodeDefinition?: (nodeData: GraphNodeData) => string | undefined
  /** 节点悬浮提示文案，默认为定义，无定义时回退为 label */
  nodeTooltip?: (nodeData: GraphNodeData) => string | undefined
  /** 边悬浮提示文案，默认为「target 是 source 的<关系>」 */
  edgeTooltip?: (ctx: EdgeTooltipContext) => string | undefined
  onNodeClick?: (nodeData: any) => void
  onNodeRightClick?: (nodeData: any) => void
  onMoreNodeClick?: (moreNodeData: any) => void
  onBackgroundDblClick?: (position: { x: number; y: number }) => void
  onNodeDblClick?: (nodeData: any) => void
  onEdgeDblClick?: (edgeData: any) => void
  onSelectionChange?: (selectedNodes: any[]) => void
  onNodeDelete?: (nodeData: any) => void
  onEdgeDelete?: (edgeData: any) => void
}

// 默认的定义提取：取第一个词性定义对的定义
const defaultNodeDefinition = (data: GraphNodeData): string | undefined =>
  data.posDefinitions?.[0]?.definition

export function useCytoscape(options: UseCytoscapeOptions) {
  const depthEffects = {
    enabled: options.depthEffects?.enabled ?? true,
    autoDepth: options.depthEffects?.autoDepth ?? true,
    focusOnHover: options.depthEffects?.focusOnHover ?? true,
    fadeStrength: Math.min(1, Math.max(0, options.depthEffects?.fadeStrength ?? 0.7)),
  }
  const focusOnHover = depthEffects.enabled && depthEffects.focusOnHover

  // 关系类型工具（基于宿主注入的配置）
  const getRelationTypes = () => options.relationTypes || []
  const isSymmetricRelation = (relationKey: string): boolean => {
    const rt = getRelationTypes().find((t) => t.key === relationKey)
    return rt?.pairWith === relationKey
  }
  const getNodeDefinition = (data: GraphNodeData) =>
    (options.nodeDefinition ?? defaultNodeDefinition)(data)

  const containerRef = ref<HTMLElement | null>(null)
  // shallowRef：cytoscape 实例不能被 Vue 深层代理，
  // 否则其内部基于对象身份的样式脏标记会偶发失效（表现为部分节点样式不刷新）
  const cyInstance = shallowRef<Core | null>(null)

  // 布局伸缩的累计倍率（滚轮缩放不改变画布 zoom，而是伸缩节点间距）
  let layoutScale = 1
  const MIN_LAYOUT_SCALE = 0.2
  const MAX_LAYOUT_SCALE = 5

  // 缩小到低档位时降级节点显示：先缩小字体，再退化为空心圆点并把线条变细
  const LOD_SMALL_FONT_SCALE = 0.45
  const LOD_DOT_SCALE = 0.25

  const updateLod = () => {
    if (!cyInstance.value) return
    const cy = cyInstance.value
    cy.batch(() => {
      cy.nodes().toggleClass('lod-small', layoutScale < LOD_SMALL_FONT_SCALE)
      cy.nodes().toggleClass('lod-dot', layoutScale <= LOD_DOT_SCALE)
      cy.edges().toggleClass('lod-thin', layoutScale <= LOD_DOT_SCALE)
    })
  }

  // 自定义滚轮缩放：保持节点大小不变，以鼠标位置为锚点伸缩节点间距（连线长度）
  const handleWheel = (e: WheelEvent) => {
    if (!cyInstance.value || !containerRef.value) return
    e.preventDefault()

    const cy = cyInstance.value

    // 计算本次伸缩系数，并钳制累计倍率，避免布局收缩成一点或无限扩散
    let factor = Math.pow(1.002, -e.deltaY)
    const clampedScale = Math.min(MAX_LAYOUT_SCALE, Math.max(MIN_LAYOUT_SCALE, layoutScale * factor))
    factor = clampedScale / layoutScale
    if (factor === 1) return
    layoutScale = clampedScale

    // 把鼠标位置换算成模型坐标作为锚点
    const rect = containerRef.value.getBoundingClientRect()
    const pan = cy.pan()
    const zoom = cy.zoom()
    const anchor = {
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom,
    }

    cy.batch(() => {
      cy.nodes().positions((node) => {
        const p = node.position()
        return {
          x: anchor.x + (p.x - anchor.x) * factor,
          y: anchor.y + (p.y - anchor.y) * factor,
        }
      })
    })

    // 根据新的伸缩档位更新降级显示
    updateLod()
  }

  // 按住空间键拖动节点时，暂停力传导，只移动被拖动的单个节点
  let isSpacePressed = false

  const isEditableTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false
    return (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      target.closest('input') !== null ||
      target.closest('textarea') !== null
    )
  }

  const handleSpaceKeyDown = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || isEditableTarget(e.target)) return
    isSpacePressed = true
  }

  const handleSpaceKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      isSpacePressed = false
    }
  }

  // Keyboard event handler for Delete key
  const handleKeyDown = (e: KeyboardEvent) => {
    // 支持 Delete (Windows/Linux) 和 Backspace (Mac) 键
    // Mac: Backspace 键的 e.key 是 'Backspace'
    // Windows/Linux: Delete 键的 e.key 是 'Delete'
    if ((e.key === 'Delete' || e.key === 'Backspace') && cyInstance.value) {
      // 检查焦点是否在输入框、文本区域或可编辑元素上
      const target = e.target as HTMLElement
      const isInputElement =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('input') !== null ||
        target.closest('textarea') !== null

      // 如果焦点在输入元素上，不触发删除功能
      if (isInputElement) {
        return
      }

      // 检查是否有选中的边（关系）
      const selectedEdges = cyInstance.value.edges(':selected')
      if (selectedEdges.length > 0) {
        // 阻止 Backspace 的默认行为（页面后退）
        e.preventDefault()

        // 删除选中的边（关系）
        if (options.onEdgeDelete) {
          selectedEdges.forEach((edge: any) => {
            options.onEdgeDelete?.(edge.data())
          })
        }
        return
      }

      // 检查是否有选中的节点
      const selectedNodes = cyInstance.value.nodes(':selected')
      if (selectedNodes.length > 0) {
        // 阻止 Backspace 的默认行为（页面后退）
        e.preventDefault()

        // 删除选中的节点
        if (options.onNodeDelete) {
          selectedNodes.forEach((node: any) => {
            options.onNodeDelete?.(node.data())
          })
        }
      }
    }
  }

  const initCytoscape = () => {
    if (!containerRef.value) return

    // 关系类型配置由宿主注入
    const relationTypes = getRelationTypes()

    const edgeStyles = relationTypes.map((rt) => {
      // 箭头形状映射
      const arrowStyle = rt.arrowStyle || 'filled'
      let arrowShape: 'triangle' | 'triangle-tee' | 'vee' | 'none' = 'triangle'
      let arrowFill: 'filled' | 'hollow' = 'filled'

      switch (arrowStyle) {
        case 'filled':
          arrowShape = 'triangle'
          arrowFill = 'filled'
          break
        case 'hollow':
          arrowShape = 'triangle'
          arrowFill = 'hollow'
          break
        case 'line':
          arrowShape = 'vee'
          arrowFill = 'filled'
          break
        case 'none':
          arrowShape = 'none'
          arrowFill = 'filled'
          break
      }

      return {
        selector: `edge[relation="${rt.key}"]`,
        style: {
          'line-color': rt.color,
          'target-arrow-color': rt.color,
          'line-style': rt.lineStyle,
          'target-arrow-shape': arrowShape,
          'target-arrow-fill': arrowFill,
        },
      }
    })

    // Cytoscape 3.34 起弃用 width/height: label。改用函数按标签长度估算尺寸，
    // 同时让各景深层级拥有真实的节点体积差，而不只是字号差。
    const nodeLabel = (node: NodeSingular) =>
      String(node.data('displayLabel') ?? node.data('label') ?? '')
    const nodeWidth = (node: NodeSingular, fontSize: number, min: number, max = 180) => {
      const longestLine = nodeLabel(node).split('\n').reduce((longest, line) =>
        line.length > longest.length ? line : longest, '')
      return Math.min(max, Math.max(min, Math.ceil(longestLine.length * fontSize * 0.68 + 24)))
    }
    const nodeHeight = (node: NodeSingular, fontSize: number, min: number) => {
      const lineCount = Math.max(1, nodeLabel(node).split('\n').length)
      return Math.max(min, Math.ceil(lineCount * fontSize * 1.35 + 18))
    }

    // 动态样式同时包含 node/edge 属性，使用宽类型规避旧版 @types 的联合推导限制。
    const depthStyle: any[] = depthEffects.enabled
      ? [
          {
            selector: 'node.orbit-depth-0',
            style: {
              'font-size': '18px',
              'min-width': '68px',
              'min-height': '68px',
              width: (node: NodeSingular) => nodeWidth(node, 18, 68),
              height: (node: NodeSingular) => nodeHeight(node, 18, 54),
              padding: '7px',
              opacity: 1,
              'z-index': 20,
              'underlay-color': '#0f172a',
              'underlay-opacity': 0.16,
              'underlay-padding': 8,
              'underlay-shape': 'round-rectangle',
            },
          },
          {
            selector: 'node.orbit-depth-1',
            style: {
              'font-size': '14px',
              'min-width': '52px',
              'min-height': '52px',
              width: (node: NodeSingular) => nodeWidth(node, 14, 52, 150),
              height: (node: NodeSingular) => nodeHeight(node, 14, 44),
              opacity: 1 - depthEffects.fadeStrength * 0.08,
              'z-index': 16,
              'underlay-color': '#0f172a',
              'underlay-opacity': 0.12,
              'underlay-padding': 6,
              'underlay-shape': 'round-rectangle',
            },
          },
          {
            selector: 'node.orbit-depth-2',
            style: {
              'font-size': '12px',
              'min-width': '44px',
              'min-height': '44px',
              width: (node: NodeSingular) => nodeWidth(node, 12, 44, 130),
              height: (node: NodeSingular) => nodeHeight(node, 12, 36),
              opacity: 1 - depthEffects.fadeStrength * 0.25,
              'z-index': 12,
              'underlay-color': '#0f172a',
              'underlay-opacity': 0.08,
              'underlay-padding': 4,
              'underlay-shape': 'round-rectangle',
            },
          },
          {
            selector: 'node.orbit-depth-3',
            style: {
              'font-size': '10px',
              'min-width': '38px',
              'min-height': '38px',
              width: (node: NodeSingular) => nodeWidth(node, 10, 38, 110),
              height: (node: NodeSingular) => nodeHeight(node, 10, 31),
              opacity: 1 - depthEffects.fadeStrength * 0.42,
              'z-index': 8,
              'underlay-color': '#0f172a',
              'underlay-opacity': 0.05,
              'underlay-padding': 2,
              'underlay-shape': 'round-rectangle',
            },
          },
          {
            selector: 'node.orbit-depth-far',
            style: {
              'font-size': '9px',
              'min-width': '34px',
              'min-height': '34px',
              width: (node: NodeSingular) => nodeWidth(node, 9, 34, 92),
              height: (node: NodeSingular) => nodeHeight(node, 9, 27),
              opacity: 1 - depthEffects.fadeStrength * 0.58,
              'z-index': 4,
              'underlay-opacity': 0,
            },
          },
          {
            selector: 'node[?isCenter]',
            style: {
              'border-width': 4,
              'underlay-color': '#38bdf8',
              'underlay-opacity': 0.2,
              'underlay-padding': 16,
              'underlay-shape': 'round-rectangle',
            },
          },
          {
            selector: 'edge.orbit-depth-0',
            style: {
              width: 3,
              opacity: 0.94,
              'arrow-scale': 1.5,
              'z-index': 10,
            },
          },
          {
            selector: 'edge.orbit-depth-1',
            style: {
              width: 1.7,
              opacity: 1 - depthEffects.fadeStrength * 0.28,
              'arrow-scale': 1.2,
              'z-index': 7,
            },
          },
          {
            selector: 'edge.orbit-depth-far',
            style: {
              width: 1,
              opacity: 1 - depthEffects.fadeStrength * 0.55,
              'arrow-scale': 0.9,
              'z-index': 3,
            },
          },
        ]
      : []

    const focusStyle: any[] = focusOnHover
      ? [
          {
            selector: 'node.orbit-dimmed',
            style: {
              opacity: 0.12,
              'text-opacity': 0.08,
            },
          },
          {
            selector: 'edge.orbit-dimmed',
            style: {
              opacity: 0.06,
            },
          },
          {
            selector: 'node.orbit-context',
            style: {
              opacity: 1,
            },
          },
          {
            selector: 'edge.orbit-context',
            style: {
              opacity: 0.92,
            },
          },
          {
            selector: 'node.orbit-hovered',
            style: {
              opacity: 1,
              'border-width': 4,
              'underlay-color': '#7dd3fc',
              'underlay-opacity': 0.28,
              'underlay-padding': 14,
              'underlay-shape': 'round-rectangle',
            },
          },
        ]
      : []

    const cy = cytoscape({
      container: containerRef.value,
      // 禁用默认的滚轮/双指缩放：改由自定义 wheel 处理器伸缩节点间距，
      // 保持节点大小不变（程序化 zoom 如 fit/center 不受影响）
      userZoomingEnabled: false,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#3498db',
            'background-opacity': 0.6,
            label: 'data(label)',
            shape: 'round-rectangle',
            color: '#2c3e50',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-family': '"SF Mono", "Monaco", "Inconsolata", "Fira Code", "Fira Mono", "Roboto Mono", "Source Code Pro", "Courier New", monospace',
            'font-size': '16px',
            'font-weight': 600,
            'min-width': '60px',
            'min-height': '60px',
            width: (node: NodeSingular) => nodeWidth(node, 16, 60),
            height: (node: NodeSingular) => nodeHeight(node, 16, 48),
            'padding': '5px',
            'border-width': 2,
            'border-color': '#2980b9',
            'text-outline-width': 2,
            'text-outline-color': '#fff',
            'text-outline-opacity': 0.6,
            'text-wrap': 'wrap',
            'text-max-width': '150px',
          },
        },
        {
          // 展示用标签（可能含定义），由 updateNodeLabels 写入 data
          selector: 'node[displayLabel]',
          style: {
            label: 'data(displayLabel)',
          },
        },
        {
          // 基于关系数量的着色，由 updateNodeColors 写入 data
          selector: 'node[degreeColor]',
          style: {
            'background-color': 'data(degreeColor)',
            'border-color': 'data(degreeBorder)',
          },
        },
        ...depthStyle,
        {
          // 节点内显示定义时的排版
          selector: 'node.with-definition',
          style: {
            'font-size': '14px',
            'line-height': 1.25,
            'text-max-width': '180px',
            'min-width': '85px',
            'min-height': '85px',
            width: '180px',
            height: '85px',
          },
        },
        {
          // 置于 degreeColor 之后，保证选中色能覆盖度数着色
          selector: 'node:selected',
          style: {
            'background-color': '#e74c3c',
            'border-color': '#c0392b',
          },
        },
        {
          selector: 'node.active-node',
          style: {
            'border-width': 4,
            'border-color': '#fb923c',
            'background-color': '#fff7ed',
          },
        },
        {
          // 缩小时先降字号
          selector: 'node.lod-small',
          style: {
            'font-size': '12px',
          },
        },
        {
          // 缩到最小档位：隐藏文字，退化为空心圆点（边框色沿用度数色）
          selector: 'node.lod-dot',
          style: {
            label: '',
            shape: 'ellipse',
            width: '14px',
            height: '14px',
            'min-width': '14px',
            'min-height': '14px',
            padding: '0px',
            'background-opacity': 0,
            'border-width': 2,
          },
        },
        {
          selector: 'node[?isMoreNode]',
          style: {
            'background-color': '#95a5a6',
            'border-color': '#7f8c8d',
            'border-width': 2,
            shape: 'ellipse',
            width: '30px',
            height: '30px',
            'font-size': '20px',
            'font-weight': 'bold',
            'text-valign': 'center',
            'text-halign': 'center',
            'min-width': '30px',
            'min-height': '30px',
            padding: '0px',
            'text-outline-width': 0,
            'text-wrap': 'none',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'arrow-scale': 1.5,
          },
        },
        {
          // 缩到最小档位时线条变细
          selector: 'edge.lod-thin',
          style: {
            width: 1,
            'arrow-scale': 0.8,
          },
        },
        {
          // 被关系类型筛选隐藏的边，由 updateEdgeVisibility 切换 class
          selector: 'edge.hidden-relation',
          style: {
            display: 'none',
          },
        },
        {
          selector: 'edge:selected',
          style: {
            width: 4,
            'line-color': '#e74c3c',
            'target-arrow-color': '#e74c3c',
          },
        },
        {
          selector: 'edge[relation="more"]',
          style: {
            'line-color': '#95a5a6',
            'target-arrow-color': '#95a5a6',
            'line-style': 'dashed',
            width: 1.5,
            'target-arrow-shape': 'none',
          },
        },
        ...edgeStyles,
        // 聚焦样式放在关系色之后，确保悬浮时的空间层次不会被覆盖
        ...focusStyle,
      ],
      minZoom: 0.3,
      maxZoom: 3,
    })

    // 记录节点点击顺序
    let clickedNodesOrder: string[] = []

    // Node click handler
    cy.on('tap', 'node', (e: any) => {
      const node = e.target as NodeSingular
      const nodeData = node.data()
      const nodeId = nodeData.id

      // 处理"+"节点的点击
      if (nodeData.isMoreNode) {
        if (options.onMoreNodeClick) {
          options.onMoreNodeClick(nodeData)
        }
        return
      }

      // 如果是多选模式（按住 Ctrl/Cmd 或者 Shift）
      if (e.originalEvent.ctrlKey || e.originalEvent.metaKey || e.originalEvent.shiftKey) {
        // 添加到点击顺序
        if (!clickedNodesOrder.includes(nodeId)) {
          clickedNodesOrder.push(nodeId)
        }
      } else {
        // 单选模式，重置顺序
        clickedNodesOrder = [nodeId]
      }

      if (options.onNodeClick) {
        options.onNodeClick(nodeData)
      }
    })

    // Node right-click handler (context menu)
    cy.on('cxttap', 'node', (e: any) => {
      const node = e.target as NodeSingular
      const nodeData = node.data()

      // 忽略"+"节点的右键点击
      if (nodeData.isMoreNode) {
        return
      }

      // 阻止浏览器默认右键菜单
      e.originalEvent.preventDefault()

      if (options.onNodeRightClick) {
        options.onNodeRightClick(nodeData)
      }
    })


    // Double-click handlers
    cy.on('dbltap', (e: any) => {
      if (e.target === cy) {
        // 双击背景 - 添加新词汇，传递点击位置
        if (options.onBackgroundDblClick) {
          const position = e.position || e.cyPosition
          options.onBackgroundDblClick(position)
        }
      } else if (e.target.isNode && e.target.isNode()) {
        // 双击节点 - 搜索该节点（不触发单击事件）
        const node = e.target as NodeSingular
        const nodeData = node.data()

        // 忽略"+"节点的双击
        if (nodeData.isMoreNode) {
          return
        }

        if (options.onNodeDblClick) {
          options.onNodeDblClick(nodeData)
          // 阻止显示词汇详情
          e.stopPropagation()
          return false
        }
      } else if (e.target.isEdge && e.target.isEdge()) {
        // 双击边 - 编辑关系
        if (options.onEdgeDblClick) {
          const edge = e.target
          options.onEdgeDblClick(edge.data())
          e.stopPropagation()
          return false
        }
      }
    })

    // Selection change handler - notify when selection changes
    cy.on('select unselect', 'node', () => {
      // 自动取消选中"+"节点
      const selectedMoreNodes = cy.nodes(':selected').filter((node: any) => node.data().isMoreNode)
      if (selectedMoreNodes.length > 0) {
        selectedMoreNodes.unselect()
      }

      if (options.onSelectionChange) {
        const selectedNodesSet = cy.nodes(':selected')

        // 清理已取消选择的节点
        const selectedIds = selectedNodesSet.map((node: any) => node.data().id)
        clickedNodesOrder = clickedNodesOrder.filter(id => selectedIds.includes(id))

        // 按点击顺序排序选中的节点
        const sortedNodes = clickedNodesOrder
          .map(id => selectedNodesSet.filter((node: any) => node.data().id === id)[0])
          .filter(node => node)
          .map((node: any) => node.data())

        options.onSelectionChange(sortedNodes)
      }

      // 更新节点颜色（取消选中时恢复原始颜色）
      updateNodeColors()
    })

    // Background click handler - clear click order and close detail when clicking background
    cy.on('tap', (e: any) => {
      if (e.target === cy) {
        clickedNodesOrder = []
        if (options.onNodeClick) {
          options.onNodeClick(null)
        }
      }
    })

    // Hover tooltips - 节点显示定义，边显示关系说明
    // mousemove 只注册一次，通过 activeTooltip 跟随当前显示中的 tooltip，
    // 避免每次 mouseover 都注册新监听器造成泄漏
    let tooltipDiv: HTMLDivElement | null = null
    let edgeTooltipDiv: HTMLDivElement | null = null
    let activeTooltip: HTMLDivElement | null = null

    // 关系类型标签映射（与边的颜色样式一样，在初始化时构建一次）
    const relationLabelMap = new Map(relationTypes.map(rt => [rt.key, rt.label]))

    const createTooltipDiv = (): HTMLDivElement => {
      const div = document.createElement('div')
      div.style.position = 'absolute'
      div.style.backgroundColor = 'rgba(0, 0, 0, 0.85)'
      div.style.color = 'white'
      div.style.padding = '8px 12px'
      div.style.borderRadius = '6px'
      div.style.fontSize = '13px'
      div.style.maxWidth = '300px'
      div.style.zIndex = '1000'
      div.style.pointerEvents = 'none'
      div.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)'
      div.style.backdropFilter = 'blur(4px)'
      containerRef.value?.appendChild(div)
      return div
    }

    const positionTooltip = (div: HTMLDivElement, evt: MouseEvent) => {
      if (!containerRef.value) return
      const containerRect = containerRef.value.getBoundingClientRect()
      div.style.left = `${evt.clientX - containerRect.left + 15}px`
      div.style.top = `${evt.clientY - containerRect.top + 15}px`
    }

    const showTooltip = (div: HTMLDivElement, text: string, evt?: MouseEvent) => {
      div.textContent = text
      div.style.display = 'block'
      activeTooltip = div
      if (evt) {
        positionTooltip(div, evt)
      }
    }

    const hideTooltip = (div: HTMLDivElement | null) => {
      if (div) {
        div.style.display = 'none'
      }
      if (activeTooltip === div) {
        activeTooltip = null
      }
    }

    cy.on('mousemove', (e: any) => {
      if (activeTooltip && e.originalEvent) {
        positionTooltip(activeTooltip, e.originalEvent)
      }
    })

    // 悬浮中的元素被移除时（如切换深度、重新搜索）不会触发 mouseout，需主动隐藏
    cy.on('remove', () => {
      if (!activeTooltip) return
      hideTooltip(tooltipDiv)
      hideTooltip(edgeTooltipDiv)
    })

    cy.on('mouseover', 'node', (e: any) => {
      const node = e.target as NodeSingular

      if (focusOnHover) {
        const context = node.closedNeighborhood()
        cy.elements().difference(context).addClass('orbit-dimmed')
        context.addClass('orbit-context')
        node.addClass('orbit-hovered')
      }

      // "+"虚拟节点不显示提示
      if (node.data('isMoreNode')) {
        return
      }

      // 默认：显示节点定义，没有定义时回退显示词汇本身；可由宿主的 nodeTooltip 覆盖
      const nodeData = node.data()
      const tooltipText = options.nodeTooltip
        ? options.nodeTooltip(nodeData)
        : getNodeDefinition(nodeData) || nodeData.label

      if (tooltipText) {
        if (!tooltipDiv) {
          tooltipDiv = createTooltipDiv()
        }
        showTooltip(tooltipDiv, tooltipText, e.originalEvent)
      }
    })

    cy.on('mouseout', 'node', () => {
      hideTooltip(tooltipDiv)
      if (focusOnHover) {
        cy.elements().removeClass('orbit-dimmed orbit-context orbit-hovered')
      }
    })

    cy.on('mouseover', 'edge', (e: any) => {
      const edgeData = e.target.data()

      // 获取源节点和目标节点的 label
      const sourceLabel = cy.getElementById(edgeData.source).data('label')
      const targetLabel = cy.getElementById(edgeData.target).data('label')
      const relationLabel = relationLabelMap.get(edgeData.relation) || edgeData.relation

      // 默认提示文本：目标词 是 源词 的 关系类型（如 "animal 是 dog 的上位词"）；
      // 可由宿主的 edgeTooltip 覆盖
      const ctx: EdgeTooltipContext = { sourceLabel, targetLabel, relation: edgeData.relation, relationLabel, edgeData }
      const tooltipText = options.edgeTooltip
        ? options.edgeTooltip(ctx)
        : `${targetLabel} 是 ${sourceLabel} 的${relationLabel}`

      if (!tooltipText) return

      if (!edgeTooltipDiv) {
        edgeTooltipDiv = createTooltipDiv()
      }
      showTooltip(edgeTooltipDiv, tooltipText, e.originalEvent)
    })

    cy.on('mouseout', 'edge', () => {
      hideTooltip(edgeTooltipDiv)
    })

    // 拖动力传导：拖动节点时邻居跟随移动，一跳最强、二跳变弱、三跳最弱，更远不动
    const DRAG_PROPAGATION_FACTORS = [0.55, 0.25, 0.1]

    let dragContext: {
      nodeId: string
      start: { x: number; y: number }
      followers: Array<{ node: any; start: { x: number; y: number }; factor: number }>
    } | null = null

    cy.on('grab', 'node', (e: any) => {
      const grabbed = e.target

      // 多选拖动时其他选中节点由 cytoscape 原生联动，不参与传导
      const excludeSelected = grabbed.selected()

      // BFS 按跳数收集邻居及对应传导系数
      const visited = new Set<string>([grabbed.id()])
      let frontier = grabbed as any
      const followers: Array<{ node: any; start: { x: number; y: number }; factor: number }> = []

      for (let hop = 0; hop < DRAG_PROPAGATION_FACTORS.length; hop++) {
        const next = frontier.neighborhood('node').filter((n: any) =>
          !visited.has(n.id()) && !(excludeSelected && n.selected())
        )
        if (!next.length) break
        next.forEach((n: any) => {
          visited.add(n.id())
          followers.push({ node: n, start: { ...n.position() }, factor: DRAG_PROPAGATION_FACTORS[hop] })
        })
        frontier = next
      }

      dragContext = { nodeId: grabbed.id(), start: { ...grabbed.position() }, followers }
    })

    cy.on('drag', 'node', (e: any) => {
      if (!dragContext || e.target.id() !== dragContext.nodeId) return

      // 按住空间键：只拖动单个节点，跳过力传导
      if (isSpacePressed) return

      const p = e.target.position()
      const dx = p.x - dragContext.start.x
      const dy = p.y - dragContext.start.y

      cy.batch(() => {
        dragContext!.followers.forEach((f) => {
          f.node.position({
            x: f.start.x + dx * f.factor,
            y: f.start.y + dy * f.factor,
          })
        })
      })
    })

    cy.on('free', 'node', () => {
      dragContext = null
    })

    cyInstance.value = cy
  }

  // 根据节点的关系数量返回对应的颜色
  const getNodeColorByDegree = (degree: number) => {
    // 根据关系数量返回不同的颜色
    if (degree === 0) return { bg: '#95a5a6', border: '#7f8c8d' }        // 灰色 - 孤立节点
    if (degree <= 2) return { bg: '#3498db', border: '#2980b9' }        // 蓝色 - 少量关系
    if (degree <= 5) return { bg: '#1abc9c', border: '#16a085' }        // 青色 - 中等关系
    if (degree <= 10) return { bg: '#f39c12', border: '#d68910' }       // 橙色 - 较多关系
    if (degree <= 20) return { bg: '#e67e22', border: '#ca6f1e' }       // 深橙 - 很多关系
    return { bg: '#e74c3c', border: '#c0392b' }                         // 红色 - 大量关系（核心节点）
  }

  // 把宿主提供的 depth 与自动 BFS 层级统一写入 scratch + class，避免污染宿主数据。
  // 没有显式 depth 时，只要存在 isCenter/depth=0 根节点，也能得到完整景深。
  const syncDepthData = () => {
    if (!cyInstance.value || !depthEffects.enabled) return

    const cy = cyInstance.value
    const nodes = cy.nodes()
    const adjacency = new Map<string, string[]>()
    const inferredDepth = new Map<string, number>()
    const queue: string[] = []
    const depthClasses = 'orbit-depth-0 orbit-depth-1 orbit-depth-2 orbit-depth-3 orbit-depth-far'

    const applyDepth = (element: any, depth: number | undefined, farFrom: number) => {
      element.removeClass(depthClasses)
      if (depth === undefined) {
        element.removeScratch('_orbitDepth')
        return
      }

      element.scratch('_orbitDepth', depth)
      element.addClass(depth >= farFrom ? 'orbit-depth-far' : `orbit-depth-${Math.floor(depth)}`)
    }

    nodes.forEach((node) => {
      adjacency.set(node.id(), [])
    })
    cy.edges().forEach((edge) => {
      const source = edge.source().id()
      const target = edge.target().id()
      adjacency.get(source)?.push(target)
      adjacency.get(target)?.push(source)
    })

    if (depthEffects.autoDepth) {
      nodes.forEach((node) => {
        const explicitDepth = node.data('depth')
        if (node.data('isCenter') === true || explicitDepth === 0) {
          inferredDepth.set(node.id(), 0)
          queue.push(node.id())
        }
      })

      for (let index = 0; index < queue.length; index++) {
        const id = queue[index]
        const nextDepth = (inferredDepth.get(id) ?? 0) + 1
        for (const neighborId of adjacency.get(id) ?? []) {
          if (inferredDepth.has(neighborId)) continue
          inferredDepth.set(neighborId, nextDepth)
          queue.push(neighborId)
        }
      }
    }

    cy.batch(() => {
      nodes.forEach((node) => {
        const explicitDepth = node.data('depth')
        const effectiveDepth = typeof explicitDepth === 'number'
          ? Math.max(0, explicitDepth)
          : inferredDepth.get(node.id())

        applyDepth(node, effectiveDepth, 4)
      })

      cy.edges().forEach((edge) => {
        const explicitDepth = edge.data('depth')
        const sourceDepth = edge.source().scratch('_orbitDepth')
        const targetDepth = edge.target().scratch('_orbitDepth')
        const effectiveDepth = typeof explicitDepth === 'number'
          ? Math.max(0, explicitDepth)
          : typeof sourceDepth === 'number' && typeof targetDepth === 'number'
            ? Math.min(sourceDepth, targetDepth)
            : undefined

        applyDepth(edge, effectiveDepth, 2)
      })
    })
  }

  const updateGraph = () => {
    if (!cyInstance.value) return

    const cy = cyInstance.value

    // batch 内的元素增删和样式更新只触发一次重绘
    cy.batch(() => {
      cy.elements().remove()
      cy.add(options.graphData.nodes)
      cy.add(options.graphData.edges)

      // 优先建立统一景深，后续样式与布局都读取 _orbitDepth
      syncDepthData()

      // 设置边的初始可见性
      updateEdgeVisibility()

      // 更新节点标签显示
      updateNodeLabels()

      // 应用基于关系数量的节点颜色
      updateNodeColors()
    })

    // 选中中心词并触发详情显示
    selectCenterNode()

    runLayout()
  }

  // 选中中心词的辅助函数
  const selectCenterNode = () => {
    if (!cyInstance.value) return

    const centerNodes = cyInstance.value.nodes().filter((node: any) => node.data('isCenter') === true)
    if (!centerNodes.length) return

    const centerNode = centerNodes[0]
    centerNode.select()
    // 不主动触发节点点击回调，避免前台搜索时自动打开编辑词汇弹窗
  }

  const updateEdgeVisibility = () => {
    if (!cyInstance.value) return

    const activeRelationSet = new Set(options.activeRelations)

    // 根据 activeRelations 切换隐藏 class（"more" 关系边始终显示）
    cyInstance.value.batch(() => {
      cyInstance.value!.edges().forEach((edge) => {
        const relation = edge.data('relation') as string
        const visible = relation === 'more' || activeRelationSet.has(relation)
        edge.toggleClass('hidden-relation', !visible)
      })
    })
  }

  // 更新节点颜色（基于关系数量）
  const updateNodeColors = () => {
    if (!cyInstance.value) return

    // 一次遍历统计所有节点的度数（排除指向虚拟"+"节点的 more 边）
    const degreeMap = new Map<string, number>()
    cyInstance.value.edges().forEach((edge) => {
      if (edge.data('relation') === 'more') return
      const source = edge.data('source') as string
      const target = edge.data('target') as string
      degreeMap.set(source, (degreeMap.get(source) || 0) + 1)
      degreeMap.set(target, (degreeMap.get(target) || 0) + 1)
    })

    // 颜色写入 data，由样式表的 node[degreeColor] 规则应用；
    // 选中态的红色由排在其后的 node:selected 规则覆盖，无需特判
    cyInstance.value.batch(() => {
      cyInstance.value!.nodes().forEach((node: any) => {
        const nodeData = node.data()

        // 跳过"+"虚拟节点
        if (nodeData.isMoreNode) {
          return
        }

        const colors = getNodeColorByDegree(degreeMap.get(nodeData.id) || 0)
        node.data({
          degreeColor: colors.bg,
          degreeBorder: colors.border,
        })
      })
    })
  }

  const arrangeIsolatedNodes = () => {
    if (!cyInstance.value) return

    const allNodes = cyInstance.value.nodes()
    if (!allNodes.length) return

    const isolatedNodes = allNodes.filter(node => node.connectedEdges().length === 0)
    if (!isolatedNodes.length) return

    const connectedNodes = allNodes.filter(node => node.connectedEdges().length > 0)
    const rowSize = Math.ceil(Math.sqrt(isolatedNodes.length))
    const columnCount = Math.ceil(isolatedNodes.length / rowSize)
    const columnSpacing = 160
    const rowSpacing = 110

    if (connectedNodes.length === 0) {
      const offsetX = -((columnCount - 1) * columnSpacing) / 2
      const offsetY = -((rowSize - 1) * rowSpacing) / 2

      isolatedNodes.forEach((node, idx) => {
        const col = Math.floor(idx / rowSize)
        const row = idx % rowSize
        node.position({
          x: offsetX + col * columnSpacing,
          y: offsetY + row * rowSpacing,
        })
      })
      return
    }

    const connectedBox = connectedNodes.boundingBox()
    const baseX = connectedBox.x2 + 160
    const centerY = (connectedBox.y1 + connectedBox.y2) / 2
    const gridHeight = (rowSize - 1) * rowSpacing
    const baseY = centerY - gridHeight / 2

    isolatedNodes.forEach((node, idx) => {
      const col = Math.floor(idx / rowSize)
      const row = idx % rowSize
      node.position({
        x: baseX + col * columnSpacing,
        y: baseY + row * rowSpacing,
      })
    })
  }

  type FocusMode = 'fit' | 'center'

  const isFitModeActive = ref(false)

  const focusOnRelationNodes = (mode: FocusMode = 'fit') => {
    if (!cyInstance.value) return

    // 优先检查是否有中心节点（搜索的目标节点）
    const centerNodes = cyInstance.value.nodes().filter((node: any) => node.data('isCenter') === true)

    let target
    if (centerNodes.length > 0) {
      // 如果有中心节点，只聚焦中心节点
      target = centerNodes
    } else {
      // 否则聚焦所有有关系的节点
      const connectedNodes = cyInstance.value.nodes().filter(node => node.connectedEdges().length > 0)
      target = connectedNodes.length > 0 ? connectedNodes : cyInstance.value.nodes()
    }

    if (!target.length) return

    if (mode === 'fit') {
      cyInstance.value.fit(target, 80)
    } else {
      cyInstance.value.animate(
        {
          zoom: 1,
          center: { eles: target },
        },
        {
          duration: 300,
        }
      )
    }
  }

  const runLayout = () => {
    if (!cyInstance.value) return

    // 根据节点数量决定是否使用动画
    const nodeCount = cyInstance.value?.nodes().length || 0
    const edgeCount = cyInstance.value?.edges().length || 0

    // 只有少量节点时才使用平滑动画
    const shouldAnimate = nodeCount < 50

    const layoutOptions: any = {
      name: options.layout,
      animate: shouldAnimate,
      animationDuration: shouldAnimate ? 400 : 0,
      // 停止动画的阈值
      animationThreshold: 250,
    }

    if (options.layout === 'cose') {
      // 关系类型配置由宿主注入
      const relationTypes = getRelationTypes()

      // 创建边长度函数，根据关系类型返回不同的理想长度；
      // 伪3D：层级越深的边越短（depth 0 = 与中心词直接相连）
      const idealEdgeLengthFn = (edge: any) => {
        const relation = edge.data('relation')
        const relationType = relationTypes.find(rt => rt.key === relation)
        const base = relationType?.edgeLength || 100

        const depth = edge.scratch('_orbitDepth') ?? edge.data('depth')
        const depthFactor = depth === undefined ? 1 : depth <= 0 ? 1 : depth === 1 ? 0.75 : 0.55
        return base * depthFactor
      }

      // 根据节点数量动态调整迭代次数（平衡质量与性能）
      let numIterations = 500  // 默认值，提供较好的布局质量
      let nodeRepulsion = 8000
      let edgeElasticity = 100
      let gravity = 0.25

      if (nodeCount < 30) {
        // 少量节点：追求完美布局
        numIterations = 600
        nodeRepulsion = 10000
        edgeElasticity = 120
      } else if (nodeCount < 100) {
        // 中等节点：平衡质量与速度
        numIterations = 500
        nodeRepulsion = 8000
        edgeElasticity = 100
      } else if (nodeCount < 200) {
        // 较多节点：略微降低质量换取速度
        numIterations = 400
        nodeRepulsion = 6000
        edgeElasticity = 80
      } else {
        // 大量节点：优先考虑性能
        numIterations = 300
        nodeRepulsion = 5000
        edgeElasticity = 60
        gravity = 0.4  // 增加重力让大图更紧凑
      }

      // 如果节点很多但边很少（孤立节点多），特殊处理
      const isLowConnectivity = nodeCount > 100 && edgeCount < nodeCount * 0.3

      if (isLowConnectivity) {
        numIterations = 200
        nodeRepulsion = 4000
        gravity = 0.6  // 强重力，快速收拢孤立节点
      }

      Object.assign(layoutOptions, {
        // 基础力学参数
        nodeRepulsion: nodeRepulsion,
        idealEdgeLength: idealEdgeLengthFn,
        edgeElasticity: edgeElasticity,
        gravity: gravity,

        // 迭代控制
        numIter: numIterations,

        // 温度参数（控制收敛速度和质量）
        initialTemp: 1000,       // 初始温度
        coolingFactor: 0.99,     // 冷却因子（0.99更平滑，0.95更快）
        minTemp: 1.0,            // 最小温度

        // 嵌套参数（提升布局质量）
        nestingFactor: 1.2,

        // 随机化
        randomize: false,         // 不随机化，保持一致性

        // 节点重叠处理
        nodeDimensionsIncludeLabels: true,

        // 性能优化
        refresh: 20,             // 每20次迭代刷新一次显示
        fit: false,
        padding: 30,
      })
    } else if (options.layout === 'concentric') {
      // 真正的“轨道”布局：层级越近权重越高，相同 depth 自动落在同一圈。
      Object.assign(layoutOptions, {
        concentric: (node: any) => 100 - (node.scratch('_orbitDepth') ?? node.data('depth') ?? 0),
        levelWidth: () => 1,
        minNodeSpacing: 45,
        spacingFactor: 1.15,
        startAngle: -Math.PI / 2,
        clockwise: true,
        equidistant: false,
        fit: false,
        padding: 30,
      })
    }

    // 新布局重置伸缩倍率基准，并清除降级显示
    layoutScale = 1
    updateLod()

    const layout = cyInstance.value.layout(layoutOptions)
    layout.run()

    layout.one('layoutstop', () => {
      arrangeIsolatedNodes()
      focusOnRelationNodes(isFitModeActive.value ? 'fit' : 'center')
    })
  }

  const fitView = () => {
    if (!cyInstance.value) return
    isFitModeActive.value = !isFitModeActive.value
    focusOnRelationNodes(isFitModeActive.value ? 'fit' : 'center')
  }

  const exportPNG = () => {
    if (!cyInstance.value) return

    const png = cyInstance.value.png({
      output: 'blob',
      bg: '#ffffff',
      full: true,
      scale: 2,
    }) as Blob

    const url = URL.createObjectURL(png)
    const link = document.createElement('a')
    link.href = url
    link.download = `wordnet-${Date.now()}.png`
    link.click()
    URL.revokeObjectURL(url)
  }

  // Lifecycle
  onMounted(() => {
    initCytoscape()
    updateGraph()
    // Add keyboard event listener
    window.addEventListener('keydown', handleKeyDown)
    // 空间键状态跟踪（拖动力传导开关）
    window.addEventListener('keydown', handleSpaceKeyDown)
    window.addEventListener('keyup', handleSpaceKeyUp)
    // 自定义滚轮缩放（passive: false 才能 preventDefault 阻止页面滚动）
    containerRef.value?.addEventListener('wheel', handleWheel, { passive: false })
  })

  onBeforeUnmount(() => {
    containerRef.value?.removeEventListener('wheel', handleWheel)
    cyInstance.value?.destroy()
    // Remove keyboard event listener
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('keydown', handleSpaceKeyDown)
    window.removeEventListener('keyup', handleSpaceKeyUp)
  })

  // Watch for changes
  watch(
    () => options.graphVersion,
    () => {
      const data = options.graphData
      if (!data.nodes.length && !data.edges.length) {
        cyInstance.value?.elements().remove()
        return
      }
      updateGraph()
    }
  )

  watch(
    () => options.activeRelations,
    () => {
      // 只更新边的可见性，不重新布局
      updateEdgeVisibility()
    },
    { deep: true }
  )

  watch(
    () => options.layout,
    () => {
      runLayout()
    }
  )

  const updateNodeData = (nodeId: string, newData: any) => {
    if (!cyInstance.value) return

    const node = cyInstance.value.getElementById(nodeId)
    if (node && node.isNode()) {
      // 更新节点的数据
      Object.keys(newData).forEach(key => {
        node.data(key, newData[key])
      })
      syncDepthData()
      // 重新计算展示标签（label/定义可能已变化）
      updateNodeLabels()
    }
  }

  // 更新节点标签显示（是否包含定义）
  // 标签内容写入 displayLabel data，排版差异通过 with-definition class 切换
  const updateNodeLabels = () => {
    if (!cyInstance.value) return

    cyInstance.value.batch(() => {
      cyInstance.value!.nodes().forEach((node: any) => {
        const data = node.data()

        // 跳过"+"虚拟节点
        if (data.isMoreNode) {
          return
        }

        // 定义提取器可由宿主注入，默认读 posDefinitions[0].definition
        const definition = getNodeDefinition(data) || ''

        if (options.showDefinitionInNode && definition) {
          // 显示：词汇\n定义（限制长度）
          const truncatedDef = definition.length > 40
            ? definition.substring(0, 40) + '...'
            : definition
          node.data('displayLabel', `${data.label}\n${truncatedDef}`)
          node.addClass('with-definition')
        } else {
          // 只显示词汇
          node.data('displayLabel', data.label)
          node.removeClass('with-definition')
        }
      })
    })
  }

  // Watch showDefinitionInNode changes
  watch(
    () => options.showDefinitionInNode,
    () => {
      updateNodeLabels()
    }
  )

  // 从图表中移除节点
  const removeNode = (nodeId: string) => {
    if (!cyInstance.value) return

    const node = cyInstance.value.getElementById(nodeId)
    if (node && node.isNode()) {
      // 移除节点（会自动移除相关的边）
      node.remove()
      syncDepthData()
    }
  }

  // 批量移除多个节点
  const removeNodes = (nodeIds: string[]) => {
    if (!cyInstance.value) return

    nodeIds.forEach(nodeId => {
      const node = cyInstance.value!.getElementById(nodeId)
      if (node && node.isNode()) {
        node.remove()
      }
    })
    syncDepthData()
  }

  // 移除边（关系）
  const removeEdge = (source: string, target: string, relation: string) => {
    if (!cyInstance.value) return

    if (isSymmetricRelation(relation)) {
      // 对称关系：尝试删除两个方向的边（实际只会有一条）
      const edge1 = cyInstance.value.edges(`[source="${source}"][target="${target}"][relation="${relation}"]`)
      const edge2 = cyInstance.value.edges(`[source="${target}"][target="${source}"][relation="${relation}"]`)

      if (edge1.length > 0) edge1.remove()
      if (edge2.length > 0) edge2.remove()
    } else {
      // 非对称关系：直接删除指定方向的边
      const edges = cyInstance.value.edges(`[source="${source}"][target="${target}"][relation="${relation}"]`)
      if (edges.length > 0) {
        edges.remove()
      }
    }
    syncDepthData()
  }

  // 添加边（关系）
  const addEdge = (source: string, target: string, relation: string, sourceNodeData?: any, targetNodeData?: any) => {
    if (!cyInstance.value) return

    // 对于对称关系，只添加 source < target 的边，避免重复显示
    if (isSymmetricRelation(relation) && source > target) {
      console.log(`Skipping symmetric edge: ${source} -> ${target} (will use reverse direction)`)
      return
    }

    // 检查节点是否存在，如果不存在且提供了节点数据，则自动添加
    let sourceNode = cyInstance.value.getElementById(source)
    let targetNode = cyInstance.value.getElementById(target)

    // 如果源节点不存在，在中心位置添加
    if (!sourceNode.length && sourceNodeData) {
      addNode(sourceNodeData)
      sourceNode = cyInstance.value.getElementById(source)
    }

    // 如果目标节点不存在，在源节点附近添加
    if (!targetNode.length && targetNodeData) {
      // 获取源节点的位置，在其附近创建目标节点
      let targetPosition: { x: number; y: number } | undefined

      if (sourceNode.length > 0) {
        const sourcePos = sourceNode.position()
        // 在源节点的右侧偏下方创建目标节点（偏移150px, 50px）
        targetPosition = {
          x: sourcePos.x + 150,
          y: sourcePos.y + 50
        }
      }

      addNode(targetNodeData, targetPosition)
      targetNode = cyInstance.value.getElementById(target)
    }

    if (!sourceNode.length || !targetNode.length) {
      console.warn(`Cannot add edge: source "${source}" or target "${target}" not found`)
      return
    }

    // 检查边是否已存在
    const existingEdges = cyInstance.value.edges(`[source="${source}"][target="${target}"][relation="${relation}"]`)
    if (existingEdges.length > 0) {
      console.warn('Edge already exists')
      return
    }

    // 创建边配置
    const edgeConfig: any = {
      group: 'edges',
      data: {
        source,
        target,
        relation,
      }
    }

    // 两端节点都有层级信息时，推导边的层级（用于伪3D粗细）
    const sourceDepth = sourceNode.data('depth')
    const targetDepth = targetNode.data('depth')
    if (sourceDepth !== undefined && targetDepth !== undefined) {
      edgeConfig.data.depth = Math.min(sourceDepth, targetDepth)
    }

    // 添加边到图表
    const newEdge = cyInstance.value.add(edgeConfig)

    syncDepthData()

    // 设置边的可见性（根据 activeRelations）
    newEdge.toggleClass('hidden-relation', !options.activeRelations.includes(relation))

    // 同步降级显示状态到新边
    updateLod()

    // 更新节点颜色（因为节点的关系数量变化了）
    updateNodeColors()

    return newEdge
  }

  // 添加新节点到指定位置
  const addNode = (nodeData: any, position?: { x: number; y: number }) => {
    if (!cyInstance.value) return

    // 创建节点配置
    const nodeConfig: any = {
      group: 'nodes',
      data: nodeData,
    }

    // 如果提供了位置，设置节点位置
    if (position) {
      nodeConfig.position = position
    }

    // 添加节点到图表
    const newNode = cyInstance.value.add(nodeConfig)

    syncDepthData()

    // 更新节点标签显示
    updateNodeLabels()

    // 更新节点颜色
    updateNodeColors()

    // 同步降级显示状态到新节点
    updateLod()

    // 如果没有提供位置，运行布局算法
    if (!position) {
      runLayout()
    }

    return newNode
  }

  return {
    containerRef,
    cyInstance,
    fitView,
    exportPNG,
    isFitModeActive,
    updateNodeData,
    removeNode,
    removeNodes,
    removeEdge,
    addEdge,
    addNode,
  }
}
