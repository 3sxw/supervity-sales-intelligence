'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { CardWatermark } from '@/components/ui/card-watermark'
import { Icons } from '@/components/ui/icons'
import { InsightCard, type Insight } from '@/components/ai/insights/InsightCard'
import { cn } from '@/lib/utils'

// ============================================================================
// Types — mirror /api/ops/insights
// ============================================================================

interface DerivedInsight {
  id: string
  insight_type: 'pattern' | 'anomaly' | 'recommendation'
  severity: 'critical' | 'warning' | 'info'
  title: string
  description: string
  evidence: Record<string, unknown>
  recommendation: string
  confidence: number
  generated_at: string
}

interface InsightsResponse {
  insights: DerivedInsight[]
  count: number
  counts_by_severity: { critical: number; warning: number; info: number }
  data_source: string
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
}
const itemVariants = { hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } }

function toInsight(d: DerivedInsight): Insight {
  return {
    id: d.id,
    type: d.insight_type,
    severity: d.severity,
    title: d.title,
    description: d.description,
    data: d.evidence,
    suggested_action: d.recommendation,
    confidence: d.confidence,
    created_at: d.generated_at,
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

export default function AIInsightsPage() {
  const [data, setData] = useState<InsightsResponse | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const load = useCallback(() => {
    setIsLoading(true)
    setError(null)
    apiClient
      .get<InsightsResponse>('/api/ops/insights')
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load insights'))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleAction = useCallback(
    (insight: Insight) => {
      if (insight.type === 'anomaly') {
        router.push('/workbench')
      } else if (insight.type === 'pattern' && insight.title.toLowerCase().includes('suppress')) {
        router.push('/ai/policies')
      } else {
        router.push('/ai/agents')
      }
    },
    [router]
  )

  const handleDismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id))
  }, [])

  const visible = (data?.insights || []).filter((i) => !dismissed.has(i.id))
  const counts = data?.counts_by_severity

  return (
    <motion.div className="space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div variants={itemVariants} className="flex items-center justify-between">
        <div>
          <h1 className="text-display-3 font-bold tracking-tight text-brand-navy lg:text-display-2">
            AI Insights
          </h1>
          <p className="mt-2 text-lg text-muted-foreground">
            Deterministic observations computed live from run_events, exceptions, routing_rules,
            sdr_roster, and buying_group — every card cites its evidence.
          </p>
        </div>
        <Button variant="gradient" onClick={load} disabled={isLoading}>
          {isLoading ? (
            <Icons.loader className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Icons.refresh className="mr-2 h-4 w-4" strokeWidth={1.5} />
          )}
          Refresh
        </Button>
      </motion.div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      <motion.div variants={itemVariants} className="grid gap-4 sm:grid-cols-3">
        <Card className="relative overflow-hidden">
          <CardWatermark opacity={2} scale={0.8} />
          <CardContent className="relative z-10 flex items-center gap-4 py-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-100">
              <Icons.alertCircle className="h-6 w-6 text-red-600" strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-2xl font-bold text-brand-navy">{counts?.critical ?? 0}</p>
              <p className="text-sm text-muted-foreground">Critical</p>
            </div>
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden">
          <CardWatermark opacity={2} scale={0.8} />
          <CardContent className="relative z-10 flex items-center gap-4 py-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100">
              <Icons.alertTriangle className="h-6 w-6 text-amber-600" strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-2xl font-bold text-brand-navy">{counts?.warning ?? 0}</p>
              <p className="text-sm text-muted-foreground">Warnings</p>
            </div>
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden">
          <CardWatermark opacity={2} scale={0.8} />
          <CardContent className="relative z-10 flex items-center gap-4 py-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100">
              <Icons.lightbulb className="h-6 w-6 text-blue-600" strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-2xl font-bold text-brand-navy">{counts?.info ?? 0}</p>
              <p className="text-sm text-muted-foreground">Info</p>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div variants={itemVariants}>
        <Card className="relative overflow-hidden">
          <CardWatermark opacity={2} scale={1} />
          <CardHeader className="relative z-10">
            <CardTitle>All Insights</CardTitle>
            <CardDescription>
              {visible.length} insight{visible.length === 1 ? '' : 's'} derived from live Supabase data.
            </CardDescription>
          </CardHeader>
          <CardContent className="relative z-10 space-y-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Icons.loader className="h-8 w-8 animate-spin text-brand-cornflower" />
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className={cn('mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-cornflower/20 to-brand-purple/20')}>
                  <Icons.lightbulb className="h-8 w-8 text-brand-cornflower" strokeWidth={1.5} />
                </div>
                <h3 className="font-display text-lg font-semibold text-brand-navy">
                  {error ? 'Could not load insights' : 'No insights right now'}
                </h3>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  {error
                    ? 'Check the error above and retry.'
                    : 'The operational data is currently clean — no anomalies, collisions, or capacity risks detected.'}
                </p>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {visible.map((d) => (
                  <motion.div key={d.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }}>
                    <InsightCard insight={toInsight(d)} onAction={handleAction} onDismiss={handleDismiss} />
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  )
}
