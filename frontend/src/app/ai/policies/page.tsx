'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { CardWatermark } from '@/components/ui/card-watermark'
import { Icons } from '@/components/ui/icons'
import { Switch } from '@/components/ui/switch'

// ============================================================================
// Types — mirror the real `policies` / `policy_evaluations` Supabase schema
// ============================================================================

interface Policy {
  id: string
  name: string
  policy_type: string
  description: string
  enabled: boolean
  priority: number
  config: Record<string, unknown>
  updated_at: string
}

interface PolicyEvaluation {
  id: number
  run_id: string
  policy_id: string
  entity_id: string
  result: string
  reason: string
  evidence: Record<string, unknown>
  created_at: string
}

interface ImpactLead {
  account_id: string | null
  contact_id: string | null
  account_name: string
  score: number
  tier: string | null
  run_id: string
  scored_at: string
  eligible_at_current_threshold: boolean
  eligible_at_candidate_threshold: boolean
}

interface ImpactPreview {
  policy_id: string
  current_minimum_score: number
  candidate_minimum_score: number
  total_leads_observed: number
  eligible_at_current_threshold: number
  eligible_at_candidate_threshold: number
  newly_eligible: number
  newly_suppressed: number
  leads: ImpactLead[]
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
}
const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0 },
}

const POLICY_TYPE_STYLE: Record<string, string> = {
  compliance: 'bg-red-100 text-red-700',
  governance: 'bg-purple-100 text-purple-700',
  scoring: 'bg-brand-cornflower/20 text-brand-navy',
  data_quality: 'bg-amber-100 text-amber-700',
  routing: 'bg-emerald-100 text-emerald-700',
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

function ConfigChips({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config || {})
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No config.</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="rounded-md bg-muted/60 px-2 py-1 font-mono text-[11px] text-foreground"
        >
          {k}: <span className="text-brand-navy font-semibold">{String(v)}</span>
        </span>
      ))}
    </div>
  )
}

// ============================================================================
// Generic policy card (P01, P02, P04, P05)
// ============================================================================

function PolicyCard({
  policy,
  onToggle,
  toggling,
}: {
  policy: Policy
  onToggle: (policy: Policy) => void
  toggling: boolean
}) {
  return (
    <motion.div variants={itemVariants}>
      <Card className="relative h-full overflow-hidden">
        <CardWatermark opacity={3} scale={0.9} />
        <CardHeader className="relative z-10 pb-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-brand-navy px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">
                  {policy.id}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    POLICY_TYPE_STYLE[policy.policy_type] || 'bg-muted text-muted-foreground'
                  )}
                >
                  {policy.policy_type.replace('_', ' ')}
                </span>
              </div>
              <CardTitle className="mt-2 text-base">{policy.name}</CardTitle>
            </div>
            <Switch
              checked={policy.enabled}
              disabled={toggling}
              onCheckedChange={() => onToggle(policy)}
            />
          </div>
          <CardDescription className="pt-1">{policy.description}</CardDescription>
        </CardHeader>
        <CardContent className="relative z-10 space-y-3">
          <ConfigChips config={policy.config} />
          <div className="flex items-center justify-between border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
            <span>Priority {policy.priority}</span>
            <span>Updated {formatTime(policy.updated_at)}</span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

// ============================================================================
// P03 hero panel — the critical demo control
// ============================================================================

function P03Panel({
  policy,
  onSaved,
}: {
  policy: Policy
  onSaved: (updated: Policy) => void
}) {
  const currentMin = Number(policy.config?.minimum_score ?? 0)
  const [draftValue, setDraftValue] = useState(currentMin)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  const [impact, setImpact] = useState<ImpactPreview | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [impactError, setImpactError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [evaluations, setEvaluations] = useState<PolicyEvaluation[]>([])
  const [evalError, setEvalError] = useState<string | null>(null)

  useEffect(() => {
    setDraftValue(currentMin)
  }, [currentMin])

  const fetchImpact = useCallback((candidate: number) => {
    setImpactLoading(true)
    setImpactError(null)
    apiClient
      .get<ImpactPreview>(`/api/ops/policies/P03/impact?minimum_score=${candidate}`)
      .then(setImpact)
      .catch((e) => setImpactError(e instanceof Error ? e.message : 'Failed to load impact preview'))
      .finally(() => setImpactLoading(false))
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchImpact(draftValue), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [draftValue, fetchImpact])

  const loadEvaluations = useCallback(() => {
    setEvalError(null)
    apiClient
      .get<{ evaluations: PolicyEvaluation[] }>('/api/ops/policies/P03/evaluations?limit=12')
      .then((res) => setEvaluations(res.evaluations))
      .catch((e) => setEvalError(e instanceof Error ? e.message : 'Failed to load evaluations'))
  }, [])

  useEffect(() => {
    loadEvaluations()
  }, [loadEvaluations])

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      const updated = await apiClient.patch<Policy>('/api/ops/policies/P03', {
        config: { minimum_score: draftValue },
      })
      onSaved(updated)
      setSaveSuccess(true)
      loadEvaluations()
      setTimeout(() => setSaveSuccess(false), 2500)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save policy')
    } finally {
      setSaving(false)
    }
  }

  const isDirty = draftValue !== currentMin

  return (
    <motion.div variants={itemVariants}>
      <Card className="relative overflow-hidden border-2 border-brand-cornflower/30">
        <CardWatermark opacity={4} scale={1.2} />
        <CardHeader className="relative z-10">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-gradient-to-r from-brand-navy to-brand-purple px-2 py-1 font-mono text-xs font-bold text-white">
              P03
            </span>
            <CardTitle>ICP Outreach Threshold</CardTitle>
            <span className="rounded-full bg-brand-cornflower/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-navy">
              Live threshold
            </span>
          </div>
          <CardDescription>
            {policy.description} Editing this writes directly to Supabase — the next Supervity run
            picks it up with no workflow code change.
          </CardDescription>
        </CardHeader>
        <CardContent className="relative z-10 space-y-6">
          {/* Threshold editor */}
          <div className="rounded-xl border border-border/60 bg-white/60 p-5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">minimum_score</label>
              <span className="font-display text-3xl font-bold text-brand-navy">{draftValue}</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={draftValue}
              onChange={(e) => setDraftValue(Number(e.target.value))}
              className="mt-3 w-full accent-brand-navy"
            />
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>0 — allow everything</span>
              <span>100 — allow only elite leads</span>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <input
                type="number"
                min={0}
                max={100}
                value={draftValue}
                onChange={(e) => setDraftValue(Number(e.target.value))}
                className="w-24 rounded-lg border border-input px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-cornflower/50"
              />
              <Button
                variant="gradient"
                size="sm"
                onClick={handleSave}
                disabled={!isDirty || saving}
              >
                {saving ? (
                  <>
                    <Icons.loader className="mr-2 h-3.5 w-3.5 animate-spin" />
                    Saving to Supabase...
                  </>
                ) : (
                  <>
                    <Icons.check className="mr-2 h-3.5 w-3.5" />
                    Save minimum_score = {draftValue}
                  </>
                )}
              </Button>
              <span className="text-xs text-muted-foreground">
                Current Saved Threshold: <strong className="text-brand-navy">{currentMin}</strong>
              </span>
              {saveSuccess && (
                <motion.span
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-1 text-xs font-medium text-emerald-600"
                >
                  <Icons.checkCircle className="h-3.5 w-3.5" /> Saved to Supabase
                </motion.span>
              )}
            </div>
            {saveError && (
              <p className="mt-2 text-xs text-red-600">{saveError}</p>
            )}
          </div>

          {/* Impact preview */}
          <div>
            <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-brand-navy">
              <Icons.barChart className="h-4 w-4" /> Policy Impact Preview
            </h4>
            {impactError ? (
              <ErrorBanner message={impactError} onRetry={() => fetchImpact(draftValue)} />
            ) : (
              <div className="rounded-xl border border-border/60 bg-white/60 p-4">
                {impactLoading && !impact ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                    <Icons.loader className="h-4 w-4 animate-spin" /> Computing impact from real lead
                    scores...
                  </div>
                ) : impact ? (
                  <>
                    <p className="mb-3 text-xs text-muted-foreground">
                      Comparing <strong className="text-foreground">Current Saved Threshold ({impact.current_minimum_score})</strong>
                      {' '}against{' '}
                      <strong className="text-foreground">Proposed Threshold ({impact.candidate_minimum_score})</strong>
                      {impact.current_minimum_score === impact.candidate_minimum_score && (
                        <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                          no change proposed
                        </span>
                      )}
                      .
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Stat label="Leads observed" value={impact.total_leads_observed} />
                      <Stat
                        label={`Current Eligible (saved: ${impact.current_minimum_score})`}
                        value={impact.eligible_at_current_threshold}
                      />
                      <Stat
                        label={`Proposed Eligible (draft: ${impact.candidate_minimum_score})`}
                        value={impact.eligible_at_candidate_threshold}
                        highlight
                      />
                      <Stat
                        label="Net Change"
                        value={impact.eligible_at_candidate_threshold - impact.eligible_at_current_threshold}
                        signed
                      />
                    </div>
                    {impact.leads.length > 0 && (
                      <div className="mt-4 max-h-56 overflow-y-auto rounded-lg border border-border/50">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-muted/70 text-left text-muted-foreground">
                            <tr>
                              <th className="px-3 py-2 font-medium">Lead</th>
                              <th className="px-3 py-2 font-medium">Score</th>
                              <th className="px-3 py-2 font-medium">Current (saved: {impact.current_minimum_score})</th>
                              <th className="px-3 py-2 font-medium">Proposed (draft: {impact.candidate_minimum_score})</th>
                            </tr>
                          </thead>
                          <tbody>
                            {impact.leads.map((lead) => (
                              <tr key={lead.account_id || lead.contact_id} className="border-t border-border/40">
                                <td className="px-3 py-1.5">{lead.account_name}</td>
                                <td className="px-3 py-1.5 font-mono">{lead.score}</td>
                                <td className="px-3 py-1.5">
                                  <EligibilityDot ok={lead.eligible_at_current_threshold} />
                                </td>
                                <td className="px-3 py-1.5">
                                  <EligibilityDot ok={lead.eligible_at_candidate_threshold} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No scored leads observed yet.</p>
                )}
              </div>
            )}
          </div>

          {/* Recent evaluations */}
          <div>
            <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-brand-navy">
              <Icons.clock className="h-4 w-4" /> Recent Evaluations
            </h4>
            {evalError ? (
              <ErrorBanner message={evalError} onRetry={loadEvaluations} />
            ) : evaluations.length === 0 ? (
              <p className="rounded-xl border border-border/60 bg-white/60 p-4 text-sm text-muted-foreground">
                No P03 evaluations recorded yet.
              </p>
            ) : (
              <div className="space-y-1.5">
                {evaluations.map((ev) => {
                  const pass = ev.result.toLowerCase() === 'pass'
                  return (
                    <div
                      key={ev.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-white/60 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide',
                            pass ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                          )}
                        >
                          {pass ? 'ALLOW' : ev.result}
                        </span>
                        <span className="font-mono text-muted-foreground">{ev.run_id}</span>
                        <span className="text-foreground">{ev.reason}</span>
                      </div>
                      <span className="shrink-0 text-muted-foreground">{formatTime(ev.created_at)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

function Stat({
  label,
  value,
  highlight,
  signed,
}: {
  label: string
  value: number
  highlight?: boolean
  signed?: boolean
}) {
  const display = signed && value > 0 ? `+${value}` : String(value)
  return (
    <div className="rounded-lg bg-muted/40 p-3 text-center">
      <p
        className={cn(
          'font-display text-xl font-bold',
          highlight ? 'text-brand-cornflower' : 'text-brand-navy',
          signed && value > 0 && 'text-emerald-600',
          signed && value < 0 && 'text-red-600'
        )}
      >
        {display}
      </p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  )
}

function EligibilityDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
        ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
      )}
    >
      {ok ? <Icons.check className="h-3 w-3" /> : <Icons.close className="h-3 w-3" />}
      {ok ? 'PASS' : 'BLOCK'}
    </span>
  )
}

// ============================================================================
// Page
// ============================================================================

export default function AIPoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const loadPolicies = useCallback(() => {
    setIsLoading(true)
    setLoadError(null)
    apiClient
      .get<{ policies: Policy[] }>('/api/ops/policies')
      .then((res) => setPolicies(res.policies))
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Failed to load policies'))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    loadPolicies()
  }, [loadPolicies])

  const handleToggle = useCallback(async (policy: Policy) => {
    setTogglingId(policy.id)
    const previous = policies
    setPolicies((prev) => prev.map((p) => (p.id === policy.id ? { ...p, enabled: !p.enabled } : p)))
    try {
      const updated = await apiClient.patch<Policy>(`/api/ops/policies/${policy.id}`, {
        enabled: !policy.enabled,
      })
      setPolicies((prev) => prev.map((p) => (p.id === policy.id ? updated : p)))
    } catch {
      setPolicies(previous)
    } finally {
      setTogglingId(null)
    }
  }, [policies])

  const p03 = useMemo(() => policies.find((p) => p.id === 'P03'), [policies])
  const otherPolicies = useMemo(() => policies.filter((p) => p.id !== 'P03'), [policies])

  const stats = {
    total: policies.length,
    enabled: policies.filter((p) => p.enabled).length,
  }

  return (
    <motion.div className="space-y-6" variants={containerVariants} initial="hidden" animate="visible">
      <motion.div variants={itemVariants}>
        <h1 className="text-display-3 font-bold tracking-tight text-brand-navy lg:text-display-2">
          AI Policies
        </h1>
        <p className="mt-1 text-lg text-muted-foreground">
          The live governance rules every Supervity run is evaluated against — read and written
          directly from Supabase.
        </p>
      </motion.div>

      {loadError && <ErrorBanner message={loadError} onRetry={loadPolicies} />}

      <motion.div variants={itemVariants} className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { value: stats.total, label: 'Total Policies', icon: Icons.layers, bg: 'bg-brand-navy/10', color: 'text-brand-navy' },
          { value: stats.enabled, label: 'Enabled', icon: Icons.check, bg: 'bg-emerald-100', color: 'text-emerald-600' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-3">
              <div className={cn('rounded-lg p-2', s.bg)}>
                <s.icon className={cn('h-5 w-5', s.color)} />
              </div>
              <div>
                <p className={cn('text-2xl font-bold', s.color)}>{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            </div>
          </div>
        ))}
      </motion.div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Icons.loader className="h-8 w-8 animate-spin text-brand-cornflower" />
        </div>
      ) : policies.length === 0 && !loadError ? (
        <Card className="relative overflow-hidden">
          <CardWatermark opacity={3} scale={1} />
          <CardContent className="relative z-10 flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-cornflower/20 to-brand-purple/20">
              <Icons.brain className="h-8 w-8 text-brand-cornflower" strokeWidth={1.5} />
            </div>
            <h3 className="font-display text-lg font-semibold text-brand-navy">No policies found</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              The `policies` table in Supabase is empty.
            </p>
          </CardContent>
        </Card>
      ) : (
        <AnimatePresence>
          <div className="space-y-6">
            {p03 && <P03Panel policy={p03} onSaved={(updated) => setPolicies((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))} />}
            <motion.div variants={itemVariants} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {otherPolicies.map((policy) => (
                <PolicyCard
                  key={policy.id}
                  policy={policy}
                  onToggle={handleToggle}
                  toggling={togglingId === policy.id}
                />
              ))}
            </motion.div>
          </div>
        </AnimatePresence>
      )}
    </motion.div>
  )
}
