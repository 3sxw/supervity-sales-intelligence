'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { motion, useInView } from 'framer-motion'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CardWatermark } from '@/components/ui/card-watermark'
import { Icons } from '@/components/ui/icons'
import { cn } from '@/lib/utils'

// ============================================================================
// Types — mirror /api/ops/overview
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

interface LeadScore {
  score: number
  tier: string | null
  evaluated_threshold: number | null
  evaluated_result: string | null
  source: 'run_event' | 'policy_evaluation' | 'correlated_other_run'
  correlated_run_id?: string
  would_pass_current_live_threshold?: boolean
}

interface RunSummary {
  run_id: string
  account_id: string | null
  account_name: string
  contact_id: string | null
  started_at: string
  last_event_at: string
  final_status: string
  policy_outcome: string | null
  route_outcome: string | null
  crm_outcome: string | null
  lead_score: LeadScore | null
  event_count: number
  events?: RunEvent[]
}

interface RecentRun {
  run_id: string
  account_id: string | null
  account_name: string
  final_status: string
  policy_outcome: string | null
  route_outcome: string | null
  crm_outcome: string | null
  lead_score: RunSummary['lead_score']
  started_at: string
  last_event_at: string
  event_count: number
}

interface OverviewResponse {
  kpis: {
    leads_processed: number
    policy_blocks: number
    pending_human_reviews: number
    buying_groups_detected: number
    crm_actions: number
    routing_collisions: number
  }
  recent_runs: RecentRun[]
  latest_operation: RunSummary | null
  p03: { current_minimum_score: number | null }
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
}
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] as const } },
}

const STATUS_STYLE: Record<string, { bg: string; label: string }> = {
  COMPLETED: { bg: 'bg-emerald-100 text-emerald-700', label: 'Completed' },
  SUPPRESSED: { bg: 'bg-red-100 text-red-700', label: 'Suppressed' },
  HUMAN_REVIEW: { bg: 'bg-amber-100 text-amber-700', label: 'Human Review' },
  PAUSED_OR_NO_WRITE: { bg: 'bg-slate-200 text-slate-700', label: 'Paused' },
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function AnimatedNumber({ value, duration = 900 }: { value: number; duration?: number }) {
  const [displayValue, setDisplayValue] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  const isInView = useInView(ref, { once: true, amount: 0.5 })
  const hasAnimated = useRef(false)

  useEffect(() => {
    if (!isInView || hasAnimated.current) return
    hasAnimated.current = true
    const startTime = performance.now()
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(2, -10 * progress)
      setDisplayValue(Math.round(eased * value))
      if (progress < 1) requestAnimationFrame(animate)
      else setDisplayValue(value)
    }
    requestAnimationFrame(animate)
  }, [value, duration, isInView])

  return <span ref={ref}>{displayValue}</span>
}

function StatCard({
  title,
  value,
  icon: Icon,
  colorClass,
  delay = 0,
}: {
  title: string
  value: number
  icon: React.ElementType
  colorClass: string
  delay?: number
}) {
  return (
    <motion.div variants={itemVariants} transition={{ delay }} whileHover={{ y: -4 }}>
      <Card className="group relative h-full cursor-default overflow-hidden">
        <CardWatermark opacity={3} scale={0.9} />
        <CardContent className="relative z-10 p-5">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <p className="text-micro uppercase text-brand-muted transition-colors duration-200 group-hover:text-brand-cornflower">
                {title}
              </p>
              <p className="font-display text-[2.25rem] font-bold leading-none tracking-tight text-brand-navy">
                <AnimatedNumber value={value} />
              </p>
            </div>
            <motion.div
              className={cn('rounded-xl p-2.5 text-white shadow-lg', colorClass)}
              whileHover={{ scale: 1.15, rotate: 5 }}
              transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            >
              <Icon className="h-5 w-5" strokeWidth={1.5} />
            </motion.div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
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

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] || { bg: 'bg-muted text-muted-foreground', label: status }
  return (
    <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide', style.bg)}>
      {style.label}
    </span>
  )
}

const SCORE_SOURCE_LABEL: Record<string, string> = {
  run_event: 'scored in this run',
  policy_evaluation: 'from this run’s P03 evaluation',
  correlated_other_run: 'correlated from this account’s most recent scoring run',
}

function LeadScoreField({ leadScore, p03CurrentThreshold }: { leadScore: LeadScore | null; p03CurrentThreshold: number | null }) {
  if (!leadScore) {
    return <Field label="Lead Score" value="No score recorded for this run" />
  }
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Lead Score</p>
      <p className="mt-0.5 text-sm text-foreground">
        {leadScore.score}
        {leadScore.evaluated_threshold != null && (
          <span className="text-muted-foreground">
            {' '}
            (threshold at evaluation: {leadScore.evaluated_threshold}
            {leadScore.evaluated_result ? `, ${leadScore.evaluated_result.toUpperCase()}` : ''})
          </span>
        )}
      </p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{SCORE_SOURCE_LABEL[leadScore.source]}</p>
      {p03CurrentThreshold != null && (
        <p className="mt-1 text-[11px]">
          Current live P03 threshold: <strong className="text-brand-navy">{p03CurrentThreshold}</strong>
          {' — '}
          <span className={leadScore.would_pass_current_live_threshold ? 'text-emerald-600' : 'text-red-600'}>
            {leadScore.would_pass_current_live_threshold ? 'would pass now' : 'would be suppressed now'}
          </span>
        </p>
      )}
    </div>
  )
}

function LatestOperationCard({ run, p03CurrentThreshold }: { run: RunSummary | null; p03CurrentThreshold: number | null }) {
  return (
    <Card className="relative col-span-12 overflow-hidden border-2 border-brand-cornflower/30">
      <CardWatermark opacity={4} scale={1.3} />
      <CardHeader className="relative z-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Icons.zap className="h-5 w-5 text-brand-cornflower" strokeWidth={1.5} />
            Latest Operation
          </CardTitle>
          {run && <StatusBadge status={run.final_status} />}
        </div>
      </CardHeader>
      <CardContent className="relative z-10">
        {!run ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No runs observed yet in run_events.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Run ID" value={run.run_id} mono />
              <Field label="Account" value={run.account_name} />
              <Field label="Policy Outcome" value={run.policy_outcome || '—'} />
              <Field label="Route Outcome" value={run.route_outcome || '—'} />
              <Field label="CRM Outcome" value={run.crm_outcome || '—'} />
              <LeadScoreField leadScore={run.lead_score} p03CurrentThreshold={p03CurrentThreshold} />
              <Field label="Started" value={formatTime(run.started_at)} />
              <Field label="Last Event" value={formatTime(run.last_event_at)} />
            </div>
            {run.events && run.events.length > 0 && (
              <div className="border-t border-border/50 pt-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Execution timeline ({run.events.length} events)
                </p>
                <div className="flex flex-wrap gap-2">
                  {run.events.map((e) => (
                    <span
                      key={e.id}
                      className="rounded-md bg-muted/60 px-2 py-1 text-[11px] font-medium text-foreground"
                      title={`${e.operator_name} · ${formatTime(e.created_at)}`}
                    >
                      {e.operator_name.split(' ')[0]}: {e.action}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-sm text-foreground', mono && 'font-mono text-xs')}>{value}</p>
    </div>
  )
}

function RunCard({ run }: { run: RecentRun }) {
  return (
    <motion.div variants={itemVariants}>
      <Card className="relative h-full overflow-hidden">
        <CardWatermark opacity={2} scale={0.8} />
        <CardContent className="relative z-10 space-y-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-sm font-semibold text-brand-navy">{run.account_name}</p>
            <StatusBadge status={run.final_status} />
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">{run.run_id}</p>
          <div className="space-y-1 text-xs text-foreground">
            {run.policy_outcome && <p>Policy: {run.policy_outcome}</p>}
            {run.route_outcome && <p>Route: {run.route_outcome}</p>}
            {run.crm_outcome && <p className="truncate">CRM: {run.crm_outcome}</p>}
            {run.lead_score && (
              <p>
                Score: {run.lead_score.score}
                {run.lead_score.tier ? ` (${run.lead_score.tier})` : ''}
              </p>
            )}
          </div>
          <p className="pt-1 text-[10px] text-muted-foreground">{formatTime(run.last_event_at)}</p>
        </CardContent>
      </Card>
    </motion.div>
  )
}

export default function HomePage() {
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    apiClient
      .get<OverviewResponse>('/api/ops/overview')
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load overview'))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const k = data?.kpis

  return (
    <motion.div className="space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div className="col-span-12 py-2" variants={itemVariants}>
        <h1 className="text-display-3 font-bold tracking-tight text-brand-navy lg:text-display-2">
          Where Intelligence <br className="hidden sm:block" />
          <span className="text-gradient">Meets Human Judgment.</span>
        </h1>
        <p className="mt-4 text-lg font-light text-muted-foreground">
          Live view of the Supervity Sales Intelligence operation — every number below is read
          straight from Supabase.
        </p>
      </motion.div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Icons.loader className="h-8 w-8 animate-spin text-brand-cornflower" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard title="Leads Processed" value={k?.leads_processed ?? 0} icon={Icons.users} colorClass="bg-brand-navy" delay={0.05} />
            <StatCard title="Policy Blocks" value={k?.policy_blocks ?? 0} icon={Icons.shield} colorClass="bg-red-500" delay={0.1} />
            <StatCard title="Pending Human Reviews" value={k?.pending_human_reviews ?? 0} icon={Icons.alertCircle} colorClass="bg-amber-500" delay={0.15} />
            <StatCard title="Buying Groups Detected" value={k?.buying_groups_detected ?? 0} icon={Icons.building} colorClass="bg-brand-purple" delay={0.2} />
            <StatCard title="CRM Actions" value={k?.crm_actions ?? 0} icon={Icons.checkCircle} colorClass="bg-brand-cornflower" delay={0.25} />
            <StatCard title="Routing Collisions" value={k?.routing_collisions ?? 0} icon={Icons.network} colorClass="bg-gradient-to-br from-brand-navy to-brand-purple" delay={0.3} />
          </div>

          <motion.div variants={itemVariants} className="grid gap-6 lg:grid-cols-12">
            <LatestOperationCard
              run={data?.latest_operation ?? null}
              p03CurrentThreshold={data?.p03?.current_minimum_score ?? null}
            />
          </motion.div>

          <motion.div variants={itemVariants}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-brand-navy">Recent Runs</h2>
              <Link href="/ai/agents" className="flex items-center gap-1 text-sm text-brand-cornflower hover:text-brand-navy">
                View full agent activity <Icons.arrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            {data?.recent_runs?.length ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {data.recent_runs.map((run) => (
                  <RunCard key={run.run_id} run={run} />
                ))}
              </div>
            ) : (
              <Card className="relative overflow-hidden">
                <CardWatermark opacity={3} scale={1} />
                <CardContent className="relative z-10 py-10 text-center text-sm text-muted-foreground">
                  No runs recorded in run_events yet.
                </CardContent>
              </Card>
            )}
          </motion.div>
        </>
      )}
    </motion.div>
  )
}
