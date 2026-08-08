'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { CardWatermark } from '@/components/ui/card-watermark'
import { Icons } from '@/components/ui/icons'

// ============================================================================
// Types — mirror /api/ops/agents
// ============================================================================

interface RunEvent {
  id: number
  run_id: string
  operator_name: string
  operator_key: string
  action: string
  status: string
  duration_ms: number | null
  created_at: string
  payload: Record<string, unknown>
}

interface OperatorCard {
  key: string
  label: string
  kind: 'event_stream' | 'source_records'
  unit_label: string
  event_count?: number
  record_count?: number
  last_event: RunEvent | null
  status: 'active' | 'no_activity_observed' | 'source_data_available' | 'no_source_data'
  data_source?: string
  sample_records?: Record<string, unknown>[]
}

interface TimelineEntry {
  type: 'operator_event' | 'policy_evaluation'
  created_at: string
  run_id: string | null
  // operator_event fields
  operator_name?: string
  operator_key?: string
  action?: string
  status?: string
  payload?: Record<string, unknown>
  // policy_evaluation fields
  policy_id?: string
  result?: string
  reason?: string
  score?: number
  minimum_score?: number
}

interface BusinessTimeline {
  business_id: string
  account_id: string | null
  account_name: string
  run_ids: string[]
  final_status: string
  started_at: string
  last_event_at: string
  event_count: number
  timeline: TimelineEntry[]
}

interface AgentActivityResponse {
  operators: OperatorCard[]
  orchestrator: OperatorCard
  business_timelines: BusinessTimeline[]
  total_business_executions_observed: number
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVariants = { hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }

const OPERATOR_ICON: Record<string, React.ElementType> = {
  lead_enricher: Icons.globe,
  lead_scorer: Icons.brain,
  buying_group_resolver: Icons.users,
  consent_dedupe_gate: Icons.shield,
  territory_router: Icons.network,
  deal_intake_crm_updater: Icons.building,
  orchestrator: Icons.bot,
}

const STATUS_STYLE: Record<string, string> = {
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  SUPPRESSED: 'bg-red-100 text-red-700',
  HUMAN_REVIEW: 'bg-amber-100 text-amber-700',
  PAUSED_OR_NO_WRITE: 'bg-slate-200 text-slate-700',
}

const ACTION_STYLE: Record<string, string> = {
  ALLOW: 'bg-emerald-100 text-emerald-700',
  SUPPRESS: 'bg-red-100 text-red-700',
  CREATE: 'bg-brand-cornflower/20 text-brand-navy',
  UPDATE: 'bg-brand-cornflower/20 text-brand-navy',
  ROUTE: 'bg-purple-100 text-purple-700',
  NO_WRITE: 'bg-slate-200 text-slate-700',
  HUMAN_REVIEW: 'bg-amber-100 text-amber-700',
  LEAD_SCORED: 'bg-blue-100 text-blue-700',
  BUYING_GROUP_RESOLVED: 'bg-indigo-100 text-indigo-700',
}

const RESULT_STYLE: Record<string, string> = {
  pass: 'bg-emerald-100 text-emerald-700',
  block: 'bg-red-100 text-red-700',
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 p-4">
      <div className="flex items-center gap-3">
        <Icons.alertCircle className="h-5 w-5 shrink-0 text-red-600" />
        <p className="text-sm text-red-700">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <Icons.refresh className="mr-2 h-3.5 w-3.5" />
          Retry
        </Button>
      )}
    </div>
  )
}

function OperatorTile({ op }: { op: OperatorCard }) {
  const Icon = OPERATOR_ICON[op.key] || Icons.bot
  const isSource = op.kind === 'source_records'
  const active = op.status === 'active' || op.status === 'source_data_available'
  const count = isSource ? op.record_count ?? 0 : op.event_count ?? 0

  return (
    <motion.div variants={itemVariants}>
      <Card className="relative h-full overflow-hidden">
        <CardWatermark opacity={3} scale={0.8} />
        <CardContent className="relative z-10 space-y-3 p-4">
          <div className="flex items-start justify-between">
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-xl text-white',
                active ? 'bg-gradient-to-br from-brand-navy to-brand-purple' : 'bg-muted-foreground/40'
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={1.5} />
            </div>
            {isSource ? (
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                  active ? 'bg-sky-100 text-sky-700' : 'bg-muted text-muted-foreground'
                )}
              >
                <Icons.folder className="h-3 w-3" />
                Data source
              </span>
            ) : (
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                  active ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-muted-foreground')} />
                {active ? 'Active' : 'No activity observed'}
              </span>
            )}
          </div>
          <div>
            <p className="text-sm font-semibold text-brand-navy">{op.label}</p>
            <p className="text-xs text-muted-foreground">
              {count} {op.unit_label}
            </p>
          </div>
          {op.last_event ? (
            <div className="rounded-lg bg-muted/40 p-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                    ACTION_STYLE[op.last_event.action] || 'bg-muted text-muted-foreground'
                  )}
                >
                  {op.last_event.action}
                </span>
                <span className="text-[10px] text-muted-foreground">{formatTime(op.last_event.created_at)}</span>
              </div>
              <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{op.last_event.run_id}</p>
            </div>
          ) : op.data_source ? (
            <p className="rounded-lg bg-sky-50 p-2.5 text-[11px] text-sky-800">
              Source table — {op.data_source}
            </p>
          ) : (
            <p className="rounded-lg bg-muted/40 p-2.5 text-[11px] text-muted-foreground">No events yet.</p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

function TimelineEntryRow({ entry }: { entry: TimelineEntry }) {
  const [expanded, setExpanded] = useState(false)

  if (entry.type === 'policy_evaluation') {
    const resultKey = (entry.result || '').toLowerCase()
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border/60 bg-muted/20 p-2.5">
        <Icons.brain className="h-4 w-4 shrink-0 text-brand-purple" strokeWidth={1.5} />
        <span className="shrink-0 rounded bg-brand-purple/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-purple">
          {entry.policy_id} evaluation
        </span>
        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', RESULT_STYLE[resultKey] || 'bg-muted text-muted-foreground')}>
          {(entry.result || '').toUpperCase()}
        </span>
        {entry.score != null && (
          <span className="truncate text-xs text-muted-foreground">
            score {entry.score}
            {entry.minimum_score != null ? ` vs threshold ${entry.minimum_score}` : ''}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatTime(entry.created_at)}</span>
      </div>
    )
  }

  const Icon = OPERATOR_ICON[entry.operator_key || ''] || Icons.bot
  return (
    <div className="rounded-lg border border-border/50 bg-white/60 p-2.5">
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setExpanded((v) => !v)}>
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="h-4 w-4 shrink-0 text-brand-cornflower" strokeWidth={1.5} />
          <span className="truncate text-xs font-medium text-foreground">{entry.operator_name}</span>
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', ACTION_STYLE[entry.action || ''] || 'bg-muted text-muted-foreground')}>
            {entry.action}
          </span>
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold', STATUS_STYLE[entry.status || ''] || 'bg-muted text-muted-foreground')}>
            {entry.status}
          </span>
          <span className="hidden truncate font-mono text-[10px] text-muted-foreground sm:inline">{entry.run_id}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
          {formatTime(entry.created_at)}
          {expanded ? <Icons.chevronUp className="h-3 w-3" /> : <Icons.chevronDown className="h-3 w-3" />}
        </div>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.pre
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mt-2 overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] text-muted-foreground"
          >
            {JSON.stringify(entry.payload, null, 2)}
          </motion.pre>
        )}
      </AnimatePresence>
    </div>
  )
}

function BusinessTimelineCard({ session }: { session: BusinessTimeline }) {
  const [open, setOpen] = useState(false)
  return (
    <motion.div variants={itemVariants}>
      <Card className="relative overflow-hidden">
        <CardContent className="relative z-10 p-4">
          <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((v) => !v)}>
            <div className="flex min-w-0 items-center gap-3">
              {open ? <Icons.chevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Icons.chevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-brand-navy">{session.account_name}</p>
                <div className="flex flex-wrap items-center gap-1">
                  {session.run_ids.map((rid) => (
                    <span key={rid} className="font-mono text-[10px] text-muted-foreground">
                      {rid}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', STATUS_STYLE[session.final_status] || 'bg-muted text-muted-foreground')}>
                {session.final_status}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {session.event_count} events · {session.run_ids.length} run{session.run_ids.length === 1 ? '' : 's'}
              </span>
              <span className="hidden text-[11px] text-muted-foreground sm:inline">{formatTime(session.last_event_at)}</span>
            </div>
          </button>
          <AnimatePresence>
            {open && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mt-3 space-y-1.5 border-t border-border/50 pt-3"
              >
                {session.timeline.map((entry, i) => (
                  <TimelineEntryRow key={`${entry.type}-${entry.created_at}-${i}`} entry={entry} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </motion.div>
  )
}

export default function LiveAgentActivityPage() {
  const [data, setData] = useState<AgentActivityResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    apiClient
      .get<AgentActivityResponse>('/api/ops/agents')
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load agent activity'))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <motion.div className="space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div variants={itemVariants}>
        <h1 className="text-display-3 font-bold tracking-tight text-brand-navy lg:text-display-2">
          Live Agent Activity
        </h1>
        <p className="mt-2 text-lg text-muted-foreground">
          The 6 Supervity Operators, backed by real telemetry. Execution timelines below are
          correlated by account across run_ids — with real P03 policy evaluations merged in — so
          one business execution reads as one story, not fragments.
        </p>
      </motion.div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Icons.loader className="h-8 w-8 animate-spin text-brand-cornflower" />
        </div>
      ) : (
        <>
          {data?.orchestrator && (
            <motion.div variants={itemVariants}>
              <Card className="relative overflow-hidden border-2 border-brand-cornflower/30">
                <CardWatermark opacity={3} scale={1} />
                <CardContent className="relative z-10 flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-navy to-brand-purple text-white">
                      <Icons.bot className="h-5 w-5" strokeWidth={1.5} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-brand-navy">{data.orchestrator.label}</p>
                      <p className="text-xs text-muted-foreground">
                        Orchestrator · {data.orchestrator.event_count} events ·{' '}
                        {data.total_business_executions_observed} business executions observed
                      </p>
                    </div>
                  </div>
                  {data.orchestrator.last_event && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      Last: {data.orchestrator.last_event.action} @ {formatTime(data.orchestrator.last_event.created_at)}
                    </span>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}

          <motion.div variants={itemVariants} className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {data?.operators.map((op) => (
              <OperatorTile key={op.key} op={op} />
            ))}
          </motion.div>

          <motion.div variants={itemVariants}>
            <h2 className="mb-3 font-display text-lg font-semibold text-brand-navy">Business Execution Timelines</h2>
            {!data?.business_timelines.length ? (
              <Card className="relative overflow-hidden">
                <CardWatermark opacity={3} scale={1} />
                <CardContent className="relative z-10 py-10 text-center text-sm text-muted-foreground">
                  No run_events recorded yet.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {data.business_timelines.map((session) => (
                  <BusinessTimelineCard key={session.business_id} session={session} />
                ))}
              </div>
            )}
          </motion.div>
        </>
      )}
    </motion.div>
  )
}
