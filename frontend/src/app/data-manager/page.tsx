'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { CardWatermark } from '@/components/ui/card-watermark'
import { Icons } from '@/components/ui/icons'

// ============================================================================
// Types — mirror /api/ops/integrations
// ============================================================================

interface IntegrationStatus {
  name: string
  check_type: 'direct_health_check' | 'last_observed_activity' | 'inferred_from_workflow_design'
  status: string
  detail: string
  latency_ms?: number | null
  checked_at?: string
  confirmed?: boolean
  last_successful_action: Record<string, unknown> | null
  last_qualifying_trigger?: Record<string, unknown> | null
}

interface IntegrationsResponse {
  integrations: IntegrationStatus[]
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
}
const itemVariants = { hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }

const INTEGRATION_ICON: Record<string, React.ElementType> = {
  Supabase: Icons.network,
  'Supervity Auto': Icons.bot,
  HubSpot: Icons.building,
  Slack: Icons.messageSquare,
}

const STATUS_CONFIG: Record<string, { dot: string; badge: string; label: string }> = {
  operational: { dot: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700', label: 'Operational' },
  activity_observed: { dot: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700', label: 'Activity observed' },
  inferred_not_confirmed: { dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700', label: 'Inferred — not confirmed' },
  no_activity_observed: { dot: 'bg-slate-400', badge: 'bg-slate-200 text-slate-700', label: 'No activity observed' },
  error: { dot: 'bg-red-500', badge: 'bg-red-100 text-red-700', label: 'Error' },
  unknown: { dot: 'bg-slate-400', badge: 'bg-slate-200 text-slate-700', label: 'Unknown' },
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso as string).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return String(iso)
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

function IntegrationCard({ integ }: { integ: IntegrationStatus }) {
  const Icon = INTEGRATION_ICON[integ.name] || Icons.network
  const cfg = STATUS_CONFIG[integ.status] || STATUS_CONFIG.unknown
  const action = integ.last_successful_action

  return (
    <motion.div variants={itemVariants}>
      <Card className="relative h-full overflow-hidden">
        <CardWatermark opacity={3} scale={0.9} />
        <CardHeader className="relative z-10 pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-navy/10">
                <Icon className="h-5 w-5 text-brand-navy" strokeWidth={1.5} />
              </div>
              <div>
                <CardTitle className="text-base">{integ.name}</CardTitle>
                <CardDescription className="text-[11px]">
                  {integ.check_type === 'direct_health_check'
                    ? 'Direct backend health check'
                    : integ.check_type === 'inferred_from_workflow_design'
                      ? 'Inferred from workflow design'
                      : 'Last observed activity'}
                </CardDescription>
              </div>
            </div>
            <span className={cn('flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide', cfg.badge)}>
              <span className={cn('h-1.5 w-1.5 rounded-full', cfg.dot)} />
              {cfg.label}
            </span>
          </div>
        </CardHeader>
        <CardContent className="relative z-10 space-y-3">
          <p className="text-xs text-muted-foreground">{integ.detail}</p>

          {integ.latency_ms != null && (
            <div className="flex items-center gap-2 text-xs text-foreground">
              <Icons.clock className="h-3.5 w-3.5 text-muted-foreground" />
              Latency: <span className="font-mono">{integ.latency_ms}ms</span>
            </div>
          )}

          {integ.checked_at && (
            <p className="text-[10px] text-muted-foreground">Checked {formatTime(integ.checked_at)}</p>
          )}

          {action ? (
            <div className="rounded-lg bg-muted/40 p-2.5">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Last successful action
              </p>
              <div className="space-y-0.5 text-xs text-foreground">
                {Object.entries(action).map(([k, v]) => (
                  <p key={k} className="truncate">
                    <span className="text-muted-foreground">{k}:</span>{' '}
                    <span className={k === 'timestamp' ? 'font-mono' : 'font-medium'}>
                      {k === 'timestamp' ? formatTime(v as string) : String(v)}
                    </span>
                  </p>
                ))}
              </div>
            </div>
          ) : integ.last_qualifying_trigger ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
              <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                <Icons.alertTriangle className="h-3 w-3" />
                Last qualifying trigger (unconfirmed)
              </p>
              <div className="space-y-0.5 text-xs text-foreground">
                {Object.entries(integ.last_qualifying_trigger).map(([k, v]) => (
                  <p key={k} className="truncate">
                    <span className="text-muted-foreground">{k}:</span>{' '}
                    <span className={k === 'timestamp' ? 'font-mono' : 'font-medium'}>
                      {k === 'timestamp' ? formatTime(v as string) : String(v)}
                    </span>
                  </p>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
              No successful action observed yet.
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

export default function DataManagerPage() {
  const [data, setData] = useState<IntegrationsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    apiClient
      .get<IntegrationsResponse>('/api/ops/integrations')
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load integration status'))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <motion.div className="space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div variants={itemVariants} className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-display-3 font-bold tracking-tight text-brand-navy lg:text-display-2">
            Data Manager
          </h1>
          <p className="mt-2 text-lg text-muted-foreground">
            Real integration status — Supabase gets a live query; Supervity, HubSpot, and Slack are
            labeled honestly as last-observed activity, not fabricated health checks.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={isLoading}>
          {isLoading ? <Icons.loader className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Icons.refresh className="mr-2 h-3.5 w-3.5" />}
          Refresh
        </Button>
      </motion.div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {isLoading && !data ? (
        <div className="flex items-center justify-center py-16">
          <Icons.loader className="h-8 w-8 animate-spin text-brand-cornflower" />
        </div>
      ) : (
        <motion.div variants={itemVariants} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {data?.integrations.map((integ) => (
            <IntegrationCard key={integ.name} integ={integ} />
          ))}
        </motion.div>
      )}
    </motion.div>
  )
}
