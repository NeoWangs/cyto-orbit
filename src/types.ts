/**
 * 关系类型配置：决定每种关系边的颜色、线型、箭头、理想边长与配对语义。
 * 由宿主应用注入（cyto-orbit 不关心配置的存储来源）。
 */
export interface RelationTypeConfig {
  /** 关系键，与边数据中的 relation 字段对应 */
  key: string
  /** 展示名称（用于边的悬浮提示） */
  label: string
  /** 边颜色 */
  color: string
  /** 线型 */
  lineStyle: 'solid' | 'dashed' | 'dotted'
  /** 箭头样式，默认 filled */
  arrowStyle?: 'filled' | 'hollow' | 'line' | 'none'
  /** 力导向布局的理想边长，默认 100 */
  edgeLength?: number
  /** 配对关系键；等于自身 key 时视为对称关系（如同义词） */
  pairWith?: string
}

/** 节点数据：id 与 label 必需，其余字段透传给宿主回调 */
export interface GraphNodeData {
  id: string
  label: string
  /** 距中心节点的层级，用于伪3D尺寸递减（0 = 中心） */
  depth?: number
  /** 虚拟"更多"节点标记 */
  isMoreNode?: boolean
  /** 中心节点标记 */
  isCenter?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** 边数据 */
export interface GraphEdgeData {
  source: string
  target: string
  relation: string
  /** 边层级（两端节点层级的较小值），用于伪3D粗细递减 */
  depth?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface GraphData {
  nodes: Array<{ data: GraphNodeData }>
  edges: Array<{ data: GraphEdgeData }>
}

export type LayoutType = 'cose' | 'circle' | 'grid' | 'breadthfirst'
