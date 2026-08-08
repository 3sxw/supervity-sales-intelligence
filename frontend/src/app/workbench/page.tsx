'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { CardWatermark } from '@/components/ui/card-watermark'
import { Icons } from '@/components/ui/icons'

// ============================================================================
// Types — mirror the real `exceptions` Supabase schema
// ============================================================================

interface TriggeredPolicy {
  policy_id: string
  policy_name: string | null
  result: string
  reason: string | null
}

interface ExceptionRow {
  id: number
  run_id: string
  exception_type: string
  priority: string
  entity_id: string
  title: string
  reason: string
  evidence: Record<string, unknown>
  recommendation: string
  confidence: number
  status: string
  human_decision: string | null
  human_comment: string | null
  created_at: string
  resolved_at: string | null
  triggered_policies: TriggeredPolicy[]
}

type FilterType = 'pending' | 'resolved' | 'all'

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVariants = { hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }

const PRIORITY_STYLE: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-slate-100 text-slate-600',
}

const RESULT_STYLE: Record<string, string> = {
  pass: 'bg-emerald-100 text-emerald-700',
  fail: 'bg-red-100 text-red-700',
  review: 'bg-amber-100 text-amber-700',
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

function EmptyState({ filter }: { filter: FilterType }) {
  return (
    <Card className="relative overflow-hidden">
      <CardWatermark opacity={3} scale={1} />
      <CardContent className="relative z-10 flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400/20 to-brand-cornflower/20">
          <Icons.checkCircle className="h-8 w-8 text-emerald-600" strokeWidth={1.5} />
        </div>
        <h3 className="font-display text-lg font-semibold text-brand-navy">
          {filter === 'pending' ? 'Nothing pending review' : 'No exceptions found'}
        </h3>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {filter === 'pending'
            ? 'Every exception has been resolved. New exceptions will appear here as Supervity runs escalate them.'
            : 'The exceptions table has no rows matching this filter yet.'}
        </p>
      </CardContent>
    </Card>
  )
}

function ExceptionCard({
  exc,
  onDecided,
}: {
  exc: ExceptionRow
  onDecided: (updated: ExceptionRow) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isPending = exc.status === 'pending'
  const isArchived = exc.status === 'archived'

  const submit = async (decision: 'approve' | 'modify' | 'reject' | 'archive') => {
    setSubmitting(decision)
    setError(null)
    try {
      const updated = await apiClient.post<ExceptionRow>(`/api/ops/exceptions/${exc.id}/decision`, {
        decision,
        comment: comment.trim() || null,
      })
      onDecided(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record decision')
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <motion.div variants={itemVariants} layout>
      <Card className={cn('relative overflow-hidden', !isPending && 'opacity-80')}>
        <CardWatermark opacity={3} scale={1} />
        <CardHeader className="relative z-10 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    PRIORITY_STYLE[exc.priority] || 'bg-muted text-muted-foreground'
                  )}
                >
                  {exc.priority} priority
                </span>
                <span className="rounded-full bg-brand-navy/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-navy">
                  {exc.exception_type.replace(/_/g, ' ')}
                </span>
                {isPending ? (
                  <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                    <Icons.clock className="h-3 w-3" /> Pending
                  </span>
                ) : isArchived ? (
                  <span className="flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                    <Icons.archive className="h-3 w-3" /> Archived — technical
                  </span>
                ) : (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                    <Icons.checkCircle className="h-3 w-3" /> Resolved — {exc.human_decision}
                  </span>
                )}
              </div>
              <h3 className="font-display text-base font-semibold text-brand-navy">{exc.title}</h3>
              <p className="font-mono text-[11px] text-muted-foreground">
                run {exc.run_id} · entity {exc.entity_id}
              </p>
            </div>
            <div className="text-right text-[11px] text-muted-foreground">
              <p>Confidence {Math.round(exc.confidence <= 1 ? exc.confidence * 100 : exc.confidence)}%</p>
              <p>{formatTime(exc.created_at)}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="relative z-10 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</p>
            <p className="mt-1 text-sm text-foreground">{exc.reason}</p>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              AI Recommendation
            </p>
            <p className="mt-1 text-sm text-foreground">{exc.recommendation}</p>
          </div>

          {exc.triggered_policies.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Triggered Policies
              </p>
              <div className="flex flex-wrap gap-1.5">
                {exc.triggered_policies.map((tp, i) => (
                  <span
                    key={`${tp.policy_id}-${i}`}
                    className={cn(
                      'rounded-md px-2 py-1 text-[11px] font-medium',
                      RESULT_STYLE[tp.result] || 'bg-muted text-muted-foreground'
                    )}
                    title={tp.reason || undefined}
                  >
                    {tp.policy_id}: {tp.result}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-brand-cornflower hover:text-brand-navy"
            >
              {expanded ? <Icons.chevronUp className="h-3.5 w-3.5" /> : <Icons.chevronDown className="h-3.5 w-3.5" />}
              {expanded ? 'Hide' : 'Show'} raw evidence
            </button>
            <AnimatePresence>
              {expanded && (
                <motion.pre
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mt-2 overflow-x-auto rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-[11px] text-muted-foreground"
                >
                  {JSON.stringify(exc.evidence, null, 2)}
                </motion.pre>
              )}
            </AnimatePresence>
          </div>

          {isPending ? (
            <div className="space-y-2 border-t border-border/50 pt-3">
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Optional comment — required context is stored in human_feedback"
                rows={2}
                className="w-full rounded-lg border border-input px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-cornflower/50"
              />
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="gradient"
                  size="sm"
                  onClick={() => submit('approve')}
                  disabled={submitting !== null}
                >
                  {submitting === 'approve' ? (
                    <Icons.loader className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Icons.check className="mr-2 h-3.5 w-3.5" />
                  )}
                  Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => submit('modify')}
                  disabled={submitting !== null}
                >
                  {submitting === 'modify' ? (
                    <Icons.loader className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Icons.pencil className="mr-2 h-3.5 w-3.5" />
                  )}
                  Modify
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-200 text-red-600 hover:bg-red-50"
                  onClick={() => submit('reject')}
                  disabled={submitting !== null}
                >
                  {submitting === 'reject' ? (
                    <Icons.loader className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Icons.close className="mr-2 h-3.5 w-3.5" />
                  )}
                  Reject
                </Button>
                <button
                  onClick={() => submit('archive')}
                  disabled={submitting !== null}
                  className="ml-auto flex items-center gap-1.5 rounded-full px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                  title="For technical/debug artifacts that aren't a real business decision"
                >
                  {submitting === 'archive' ? (
                    <Icons.loader className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Icons.archive className="h-3.5 w-3.5" />
                  )}
                  Archive (technical/duplicate)
                </button>
              </div>
            </div>
          ) : (
            <div className="border-t border-border/50 pt-3 text-xs text-muted-foreground">
              <p>
                {isArchived ? 'Archived' : 'Resolved'} {formatTime(exc.resolved_at)} · decision{' '}
                <strong className="text-foreground">{exc.human_decision}</strong>
              </p>
              {exc.human_comment && <p className="mt-1 italic text-foreground">&ldquo;{exc.human_comment}&rdquo;</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

export default function WorkbenchPage() {
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([])
  const [filter, setFilter] = useState<FilterType>('pending')
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [counts, setCounts] = useState({ pending: 0, resolved: 0 })

  const load = useCallback((f: FilterType) => {
    setIsLoading(true)
    setLoadError(null)
    apiClient
      .get<{ exceptions: ExceptionRow[]; pending_count: number; resolved_count: number }>(
        `/api/ops/exceptions?status=${f}`
      )
      .then((res) => {
        setExceptions(res.exceptions)
        setCounts({ pending: res.pending_count, resolved: res.resolved_count })
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Failed to load exceptions'))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    load(filter)
  }, [filter, load])

  const handleDecided = useCallback(
    (updated: ExceptionRow) => {
      if (filter === 'pending') {
        setExceptions((prev) => prev.filter((e) => e.id !== updated.id))
      } else {
        setExceptions((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
      }
      setCounts((c) => ({ pending: Math.max(0, c.pending - 1), resolved: c.resolved + 1 }))
    },
    [filter]
  )

  const tabs: { id: FilterType; label: string; count: number }[] = useMemo(
    () => [
      { id: 'pending', label: 'Pending', count: counts.pending },
      { id: 'resolved', label: 'Resolved', count: counts.resolved },
      { id: 'all', label: 'All', count: counts.pending + counts.resolved },
    ],
    [counts]
  )

  return (
    <motion.div className="space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div variants={itemVariants}>
        <h1 className="text-display-3 font-bold tracking-tight text-brand-navy lg:text-display-2">
          Workbench
        </h1>
        <p className="mt-2 text-lg text-muted-foreground">
          Live exception queue from Supabase — review the AI&apos;s recommendation, then approve,
          modify, or reject.
        </p>
      </motion.div>

      {loadError && <ErrorBanner message={loadError} onRetry={() => load(filter)} />}

      <motion.div variants={itemVariants}>
        <div className="flex gap-1 rounded-xl bg-gray-100 p-1.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={cn(
                'relative flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors',
                filter === tab.id ? 'bg-white text-brand-navy shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tab.label}
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                  filter === tab.id ? 'bg-brand-navy text-white' : 'bg-muted text-muted-foreground'
                )}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </motion.div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Icons.loader className="h-8 w-8 animate-spin text-brand-cornflower" />
        </div>
      ) : exceptions.length === 0 && !loadError ? (
        <EmptyState filter={filter} />
      ) : (
        <motion.div variants={itemVariants} className="space-y-4">
          <AnimatePresence mode="popLayout">
            {exceptions.map((exc) => (
              <ExceptionCard key={exc.id} exc={exc} onDecided={handleDecided} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </motion.div>
  )
}
