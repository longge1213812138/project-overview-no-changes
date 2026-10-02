import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryImportResult, MemoryKind, MemoryListFilter, MemoryRecord } from '@fairy/core'

/**
 * 阶段 4 · 记忆面板（docs/DEV_PLAN.md §5.2）：
 * 列表（kind 筛选 + 内容搜索）/ 手动增删改 / 导出导入 JSON / 聊天管道变更实时同步。
 * 数据来源：`window.fairy.memory`（契约见 packages/core/src/ipc.ts）。
 */

/** kind 徽章五色（配色见 style.css .mem-kind-*） */
const KIND_LABELS: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  note: '备注',
  decision: '决定',
  topic: '主题'
}

const KINDS = Object.keys(KIND_LABELS) as MemoryKind[]

/** 单次拉取上限，防止记忆量大时列表过长 */
const LIST_LIMIT = 200

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** FileReader 读文本（导入文件） */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsText(file)
  })
}

export default function MemoryPanel() {
  // ===== 列表数据 =====
  const [records, setRecords] = useState<MemoryRecord[]>([])
  const [loading, setLoading] = useState(true)

  // ===== 工具栏：kind 筛选 + 搜索（防抖 300ms） =====
  const [kind, setKind] = useState<MemoryKind | 'all'>('all')
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')

  // ===== 新增 / 编辑 =====
  const [adding, setAdding] = useState(false)
  const [addContent, setAddContent] = useState('')
  const [addKind, setAddKind] = useState<MemoryKind>('note')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editKind, setEditKind] = useState<MemoryKind>('note')

  // ===== pending 态（防重复点击） =====
  const [addBusy, setAddBusy] = useState(false)
  const [editBusy, setEditBusy] = useState(false)
  const [delBusyId, setDelBusyId] = useState<number | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)

  // ===== 提示条 =====
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<MemoryImportResult | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)

  // 搜索防抖：输入 300ms 后才触发 list({query})
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(queryInput.trim()), 300)
    return () => window.clearTimeout(t)
  }, [queryInput])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const filter: MemoryListFilter = { limit: LIST_LIMIT }
      if (kind !== 'all') filter.kind = kind
      if (query) filter.query = query
      const list = await window.fairy.memory.list(filter)
      // 按 updatedAt 降序（后端契约未承诺顺序，前端兜底）
      setRecords([...list].sort((a, b) => b.updatedAt - a.updatedAt))
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [kind, query])

  // 挂载/筛选变化 → 拉列表；订阅聊天管道变更（remember/forget/抽取）→ 重新拉取
  useEffect(() => {
    void reload()
    return window.fairy.memory.onChanged(() => {
      void reload()
    })
  }, [reload])

  // ===== 新增 =====
  const handleAdd = async () => {
    const content = addContent.trim()
    if (!content || addBusy) return
    setAddBusy(true)
    setError(null)
    setNotice(null)
    setImportResult(null)
    try {
      await window.fairy.memory.add({ content, kind: addKind })
      setAdding(false)
      setAddContent('')
      setAddKind('note')
      void reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setAddBusy(false)
    }
  }

  // ===== 编辑 =====
  const startEdit = (rec: MemoryRecord) => {
    setEditingId(rec.id)
    setEditContent(rec.content)
    setEditKind(rec.kind)
  }

  const handleSaveEdit = async () => {
    const id = editingId
    const content = editContent.trim()
    if (id === null || !content || editBusy) return
    setEditBusy(true)
    setError(null)
    try {
      await window.fairy.memory.update(id, { content, kind: editKind })
      setEditingId(null)
      void reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setEditBusy(false)
    }
  }

  // ===== 删除 =====
  const handleDelete = async (rec: MemoryRecord) => {
    if (delBusyId !== null) return
    if (!window.confirm('确定删除这条记忆？')) return
    setDelBusyId(rec.id)
    setError(null)
    try {
      await window.fairy.memory.remove(rec.id)
      if (editingId === rec.id) setEditingId(null)
      void reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setDelBusyId(null)
    }
  }

  // ===== 导出 JSON =====
  const handleExport = async () => {
    if (exportBusy) return
    setExportBusy(true)
    setError(null)
    setNotice(null)
    setImportResult(null)
    try {
      const all = await window.fairy.memory.exportAll()
      if (all.length === 0) {
        setNotice('暂无记忆可导出')
        return
      }
      const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `fairy-memories-${fmtDate(Date.now())}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(errText(e))
    } finally {
      setExportBusy(false)
    }
  }

  // ===== 导入 JSON =====
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const file = input.files?.[0]
    input.value = '' // 允许重复选同一文件
    if (!file || importBusy) return
    setImportBusy(true)
    setError(null)
    setNotice(null)
    setImportResult(null)
    try {
      const text = await readFileText(file)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        setError('JSON 解析失败')
        return
      }
      setImportResult(await window.fairy.memory.importMany(parsed))
      void reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setImportBusy(false)
    }
  }

  return (
    <div className="memory-panel">
      <div className="memory-toolbar">
        <select
          className="mem-filter"
          value={kind}
          onChange={(e) => setKind(e.target.value as MemoryKind | 'all')}
        >
          <option value="all">全部</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}（{k}）
            </option>
          ))}
        </select>
        <input
          className="mem-search"
          type="search"
          placeholder="搜索记忆内容…"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
        />
        <div className="mem-toolbar-actions">
          <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
            {adding ? '收起' : '新增'}
          </button>
          <button className="btn" onClick={handleExport} disabled={exportBusy}>
            {exportBusy ? '导出中…' : '导出'}
          </button>
          <button
            className="btn"
            onClick={() => fileRef.current?.click()}
            disabled={importBusy}
          >
            {importBusy ? '导入中…' : '导入'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
        </div>
      </div>

      {error && <div className="mem-alert mem-alert-error">{error}</div>}
      {notice && <div className="mem-alert mem-alert-info">{notice}</div>}
      {importResult && (
        <div className="mem-alert mem-alert-import">
          <div>
            导入 {importResult.imported} 条，跳过 {importResult.skipped} 条
          </div>
          {importResult.errors.length > 0 && (
            <ul className="mem-import-errors">
              {importResult.errors.slice(0, 3).map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
              {importResult.errors.length > 3 && (
                <li>…另有 {importResult.errors.length - 3} 条错误未显示</li>
              )}
            </ul>
          )}
        </div>
      )}

      {adding && (
        <div className="mem-form">
          <textarea
            autoFocus
            placeholder="要记住的内容…"
            value={addContent}
            onChange={(e) => setAddContent(e.target.value)}
          />
          <div className="mem-form-row">
            <select
              value={addKind}
              onChange={(e) => setAddKind(e.target.value as MemoryKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}（{k}）
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              onClick={handleAdd}
              disabled={addBusy || !addContent.trim()}
            >
              {addBusy ? '保存中…' : '添加'}
            </button>
            <button
              className="btn"
              onClick={() => {
                setAdding(false)
                setAddContent('')
                setAddKind('note')
              }}
              disabled={addBusy}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {loading && records.length === 0 ? (
        <div className="mem-loading">记忆加载中…</div>
      ) : records.length === 0 ? (
        <div className="mem-empty">
          还没有记忆。在聊天里说『记住：XXX』，或点新增手动添加。
        </div>
      ) : (
        <div className="mem-list">
          {records.map((rec) =>
            editingId === rec.id ? (
              <div className="mem-form mem-edit-form" key={rec.id}>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                />
                <div className="mem-form-row">
                  <select
                    value={editKind}
                    onChange={(e) => setEditKind(e.target.value as MemoryKind)}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABELS[k]}（{k}）
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-primary"
                    onClick={handleSaveEdit}
                    disabled={editBusy || !editContent.trim()}
                  >
                    {editBusy ? '保存中…' : '保存'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => setEditingId(null)}
                    disabled={editBusy}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="mem-row" key={rec.id}>
                <span className={`mem-kind mem-kind-${rec.kind}`} title={rec.kind}>
                  {KIND_LABELS[rec.kind]}
                </span>
                <div className="mem-content">{rec.content}</div>
                <div className="mem-date">
                  <div>M {fmtDate(rec.updatedAt)}</div>
                  <div>D {fmtDate(rec.createdAt)}</div>
                </div>
                <div className="mem-actions">
                  <button className="btn" onClick={() => startEdit(rec)}>
                    编辑
                  </button>
                  <button
                    className="btn mem-del"
                    onClick={() => handleDelete(rec)}
                    disabled={delBusyId !== null}
                  >
                    {delBusyId === rec.id ? '删除中…' : '删除'}
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
