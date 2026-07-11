# cyto-orbit

伪 3D 交互式关系网络视图 —— 基于 [Cytoscape.js](https://js.cytoscape.org/) 的 Vue 3 composable。

为「以中心词展开的知识网络」场景设计（词网、概念图、知识图谱浏览器），中心节点最大、层级向外递减，形成轨道式的景深效果。

## 特性

- **伪 3D 层级递减**：按距中心节点的 BFS 层级（`depth` 数据）递减字号、节点尺寸、连线粗细与理想边长
- **拖动力传导**：拖动节点时邻居跟随移动，一跳最强、二跳变弱、三跳最弱、更远不动；按住空格键可只拖动单个节点
- **间距缩放**：滚轮缩放伸缩节点间距而非画布 zoom，节点像素大小保持不变
- **LOD 降级**：缩小到低档位时先降字号，最小档退化为空心圆点 + 细线
- **自适应节点**：圆角矩形，宽高跟随标签内容；可切换在节点内显示定义
- **度数着色**：按关系数量分档着色（样式表 data mapper，无逐节点内联样式）
- **交互齐全**：单击/双击/右键/多选/Delete 删除/悬浮提示（节点定义、边关系语义）
- **性能**：批量渲染（`cy.batch`）、O(N+E) 度数统计、`shallowRef` 持有实例避免 Vue 深层代理

## 安装

```bash
npm install github:NeoWangs/cyto-orbit
# 或发布到 npm 后：npm install cyto-orbit
```

`vue`（^3.3）与 `cytoscape`（^3.23）为 peer dependencies，需宿主项目自行安装。

## 使用

```vue
<script setup lang="ts">
import { useCytoscape, type RelationTypeConfig } from 'cyto-orbit'

const relationTypes: RelationTypeConfig[] = [
  { key: 'hypernym', label: '上位词', color: '#e74c3c', lineStyle: 'solid', edgeLength: 100, pairWith: 'hyponym' },
  { key: 'synonym',  label: '同义词', color: '#2ecc71', lineStyle: 'dashed', pairWith: 'synonym' }, // pairWith === key 即对称关系
]

const { containerRef, fitView, exportPNG, addNode, addEdge, removeNode, removeEdge, updateNodeData } = useCytoscape({
  get graphData() { return graphData.value },       // { nodes: [{ data: { id, label, depth?, ... } }], edges: [...] }
  get graphVersion() { return version.value },       // 变更时全量重建
  get activeRelations() { return activeKeys.value }, // 控制各关系边显隐
  get layout() { return 'cose' },
  get showDefinitionInNode() { return false },
  relationTypes,
  onNodeClick: (data) => { /* ... */ },
})
</script>

<template>
  <div ref="containerRef" style="width: 100%; height: 100%" />
</template>
```

### 数据约定

- 节点 `data.depth`（可选）：距中心的层级，`0` 为中心，驱动伪 3D 递减；不提供则统一尺寸
- 边 `data.depth`（可选）：建议取两端节点层级较小值，驱动连线粗细/长度递减
- 节点 `data.isMoreNode`（可选）：标记为"更多"虚拟节点（灰色小圆点，点击触发 `onMoreNodeClick`）
- 边 `relation: 'more'`：连接"更多"节点的虚线边

### 自定义提示文案

```ts
useCytoscape({
  // ...
  nodeDefinition: (d) => d.myDescription,                       // 定义提取（默认读 posDefinitions[0].definition）
  nodeTooltip:    (d) => d.myDescription ?? d.label,            // 节点悬浮提示
  edgeTooltip:    ({ sourceLabel, targetLabel, relationLabel }) =>
    `${sourceLabel} —${relationLabel}→ ${targetLabel}`,          // 边悬浮提示
})
```

## License

MIT
