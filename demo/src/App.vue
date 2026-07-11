<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  useCytoscape,
  type GraphData,
  type GraphEdgeData,
  type GraphNodeData,
  type LayoutType,
  type RelationTypeConfig,
} from 'cyto-orbit'
import rawData from './demo-data.json'

interface DemoWord extends GraphNodeData {
  phonetic?: string
  examples?: string[]
  posDefinitions?: Array<{ pos?: string; definition?: string }>
}

interface DemoConnection extends GraphEdgeData {
  id?: string
}

interface DemoRelation extends RelationTypeConfig {
  defaultActive?: boolean
}

interface DemoData {
  words: DemoWord[]
  connections: DemoConnection[]
  relationTypes: DemoRelation[]
  posTypes: Array<{ key: string; label: string; abbreviation: string }>
}

const demoData = rawData as unknown as DemoData
const relationTypes = demoData.relationTypes
const relationMap = new Map(relationTypes.map((relation) => [relation.key, relation]))

// 原始数据为对称关系保存双向记录；画布只保留一条，避免完全重叠。
const symmetricEdgeKeys = new Set<string>()
const connections = demoData.connections.filter((connection) => {
  const config = relationMap.get(connection.relation)
  if (config?.pairWith !== config?.key) return true

  const endpoints = [connection.source, connection.target].sort().join('::')
  const key = `${connection.relation}::${endpoints}`
  if (symmetricEdgeKeys.has(key)) return false
  symmetricEdgeKeys.add(key)
  return true
})

const centerId = ref('dog')
const selectedId = ref<string | null>('dog')
const graphVersion = ref(0)
const layout = ref<LayoutType>('cose')
const showDefinition = ref(false)
const activeRelations = ref(
  relationTypes.filter((relation) => relation.defaultActive).map((relation) => relation.key),
)

const graphData = computed<GraphData>(() => ({
  nodes: demoData.words.map((word) => ({
    data: {
      ...word,
      isCenter: word.id === centerId.value,
    },
  })),
  edges: connections.map((connection) => ({ data: { ...connection } })),
}))

const selectedWord = computed(() =>
  demoData.words.find((word) => word.id === selectedId.value) ?? null,
)

const selectedDefinition = computed(() =>
  selectedWord.value?.posDefinitions?.[0]?.definition || '暂无定义',
)

const selectedPos = computed(() => {
  const key = selectedWord.value?.posDefinitions?.[0]?.pos
  return demoData.posTypes.find((type) => type.key === key)
})

const selectedRelationCount = computed(() => {
  if (!selectedWord.value) return 0
  return connections.filter(
    (edge) => edge.source === selectedWord.value?.id || edge.target === selectedWord.value?.id,
  ).length
})

const visibleEdgeCount = computed(() =>
  connections.filter((edge) => activeRelations.value.includes(edge.relation)).length,
)

const { containerRef, cyInstance, exportPNG } = useCytoscape({
  get graphData() {
    return graphData.value
  },
  get graphVersion() {
    return graphVersion.value
  },
  get activeRelations() {
    return activeRelations.value
  },
  get layout() {
    return layout.value
  },
  get showDefinitionInNode() {
    return showDefinition.value
  },
  relationTypes,
  depthEffects: {
    enabled: true,
    autoDepth: true,
    focusOnHover: true,
    fadeStrength: 0.78,
  },
  nodeTooltip: (data) => {
    const word = data as DemoWord
    const definition = word.posDefinitions?.[0]?.definition
    return [word.label, word.phonetic, definition].filter(Boolean).join(' · ')
  },
  edgeTooltip: ({ sourceLabel, targetLabel, relationLabel }) =>
    `${sourceLabel} → ${targetLabel} · ${relationLabel}`,
  onNodeClick: (data) => {
    selectedId.value = data?.id ?? null
  },
})

let frameTimer: number | undefined

const frameGraph = () => {
  if (!cyInstance.value?.elements().length) return
  cyInstance.value.animate(
    { fit: { eles: cyInstance.value.elements(), padding: 76 } },
    { duration: 360 },
  )
}

const scheduleFrame = () => {
  window.clearTimeout(frameTimer)
  frameTimer = window.setTimeout(frameGraph, 680)
}

const recenter = (id = centerId.value) => {
  centerId.value = id
  selectedId.value = id
  graphVersion.value += 1
  scheduleFrame()
}

const toggleRelation = (key: string) => {
  activeRelations.value = activeRelations.value.includes(key)
    ? activeRelations.value.filter((activeKey) => activeKey !== key)
    : [...activeRelations.value, key]
}

const setAllRelations = (enabled: boolean) => {
  activeRelations.value = enabled ? relationTypes.map((relation) => relation.key) : []
}

const setLayout = (nextLayout: LayoutType) => {
  layout.value = nextLayout
  scheduleFrame()
}

onMounted(scheduleFrame)
</script>

<template>
  <main class="observatory">
    <header class="topbar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">
          <i></i><i></i><i></i>
        </span>
        <div>
          <p class="eyebrow">LEXICAL FIELD INSTRUMENT / 01</p>
          <h1>CYTO <span>ORBIT</span></h1>
        </div>
      </div>

      <div class="telemetry" aria-label="图谱状态">
        <div><strong>{{ demoData.words.length }}</strong><span>NODES</span></div>
        <div><strong>{{ visibleEdgeCount }}</strong><span>LINKS</span></div>
        <div><strong>{{ activeRelations.length }}</strong><span>BANDS</span></div>
      </div>

      <div class="system-status">
        <span class="status-light"></span>
        <span>DEPTH ENGINE</span>
        <strong>ONLINE</strong>
      </div>
    </header>

    <section class="workspace">
      <aside class="control-deck">
        <section class="deck-section focus-section">
          <div class="section-heading">
            <span>01</span>
            <div><small>ORIGIN</small><h2>中心词</h2></div>
          </div>

          <label class="select-shell">
            <span>FOCUS TERM</span>
            <select v-model="centerId" @change="recenter()">
              <option v-for="word in demoData.words" :key="word.id" :value="word.id">
                {{ word.label }}
              </option>
            </select>
          </label>

          <div class="quick-focus" aria-label="常用中心词">
            <button
              v-for="id in ['dog', 'mammal', 'cat', 'puppy']"
              :key="id"
              :class="{ active: centerId === id }"
              type="button"
              @click="recenter(id)"
            >
              {{ id }}
            </button>
          </div>
        </section>

        <section class="deck-section relation-section">
          <div class="section-heading relation-heading">
            <span>02</span>
            <div><small>SPECTRUM</small><h2>关系频段</h2></div>
            <div class="tiny-actions">
              <button type="button" @click="setAllRelations(true)">ALL</button>
              <button type="button" @click="setAllRelations(false)">OFF</button>
            </div>
          </div>

          <div class="relation-list">
            <label
              v-for="relation in relationTypes"
              :key="relation.key"
              class="relation-row"
              :class="{ active: activeRelations.includes(relation.key) }"
            >
              <input
                type="checkbox"
                :checked="activeRelations.includes(relation.key)"
                @change="toggleRelation(relation.key)"
              />
              <span class="relation-swatch" :style="{ '--relation-color': relation.color }"></span>
              <span class="relation-copy">
                <strong>{{ relation.label }}</strong>
                <small>{{ relation.key }}</small>
              </span>
              <span class="relation-state">{{ activeRelations.includes(relation.key) ? 'ON' : '—' }}</span>
            </label>
          </div>
        </section>

        <div class="source-note">
          <span>DATA SOURCE</span>
          <a
            href="https://github.com/EasonWangs/wordNet-navigator/blob/main/data/demo-data.json"
            target="_blank"
            rel="noreferrer"
          >
            EasonWangs / wordNet-navigator ↗
          </a>
        </div>
      </aside>

      <section class="graph-stage">
        <div class="stage-toolbar">
          <div class="layout-switch" aria-label="布局选择">
            <button
              type="button"
              :class="{ active: layout === 'cose' }"
              @click="setLayout('cose')"
            >
              FORCE NET
            </button>
            <button
              type="button"
              :class="{ active: layout === 'concentric' }"
              @click="setLayout('concentric')"
            >
              ORBIT RINGS
            </button>
          </div>

          <div class="view-actions">
            <button type="button" :class="{ active: showDefinition }" @click="showDefinition = !showDefinition">
              {{ showDefinition ? 'DEFINITION ON' : 'DEFINITION OFF' }}
            </button>
            <button type="button" @click="frameGraph">FRAME</button>
            <button type="button" @click="exportPNG">CAPTURE</button>
          </div>
        </div>

        <div class="stage-coordinate coordinate-x">X / 06.20.02</div>
        <div class="stage-coordinate coordinate-y">Y / SEMANTIC DEPTH</div>
        <div class="depth-rings" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="reticle" aria-hidden="true"><i></i><i></i></div>
        <div
          ref="containerRef"
          class="graph-canvas"
          role="img"
          aria-label="可交互词汇关系网络"
        ></div>

        <div class="depth-scale" aria-hidden="true">
          <span>NEAR</span><i></i><i></i><i></i><i></i><span>FAR</span>
        </div>

        <div class="interaction-hint">
          <span class="mouse-glyph"></span>
          <p><strong>滚轮</strong> 调整网络间距 · <strong>拖动</strong> 传导邻居 · <strong>空格 + 拖动</strong> 单节点</p>
        </div>
      </section>

      <aside class="inspector">
        <div class="inspector-topline">
          <span>NODE INSPECTOR</span>
          <small>{{ selectedWord ? 'LOCKED' : 'STANDBY' }}</small>
        </div>

        <template v-if="selectedWord">
          <div class="word-index">{{ selectedWord.id.slice(0, 2).toUpperCase() }}</div>
          <p class="word-kicker">ACTIVE LEXEME</p>
          <h2>{{ selectedWord.label }}</h2>
          <p class="phonetic">{{ selectedWord.phonetic || '/ — /' }}</p>

          <div class="word-metadata">
            <div>
              <span>PART OF SPEECH</span>
              <strong>{{ selectedPos?.abbreviation || '—' }} {{ selectedPos?.label || '未标注' }}</strong>
            </div>
            <div>
              <span>DIRECT LINKS</span>
              <strong>{{ String(selectedRelationCount).padStart(2, '0') }}</strong>
            </div>
          </div>

          <section class="definition-card">
            <span>DEFINITION / 定义</span>
            <p>{{ selectedDefinition }}</p>
          </section>

          <section class="example-section">
            <span>USAGE SIGNALS</span>
            <ol v-if="selectedWord.examples?.length">
              <li v-for="example in selectedWord.examples" :key="example">{{ example }}</li>
            </ol>
            <p v-else class="empty-copy">暂无例句</p>
          </section>

          <button
            v-if="selectedWord.id !== centerId"
            type="button"
            class="promote-button"
            @click="recenter(selectedWord.id)"
          >
            <span>设为新中心</span>
            <b>SET ORIGIN →</b>
          </button>
        </template>

        <div v-else class="inspector-empty">
          <span>+</span>
          <p>选择任一节点<br />读取词条信号</p>
        </div>

        <div class="inspector-footer">
          <span>ENGINE</span>
          <strong>CYTOSCAPE.JS</strong>
          <i :class="{ ready: cyInstance }"></i>
        </div>
      </aside>
    </section>
  </main>
</template>
