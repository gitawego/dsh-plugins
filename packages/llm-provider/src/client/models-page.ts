/**
 * The Models page's extension card for this plugin's provider row.
 *
 * The shipped Models section renders `settings.models.provider-card` for every
 * provider row, keyed by the settings namespace that owns it, precisely so a
 * plugin outside the harness can explain itself on that page. This route needs
 * it: the section's own editor cannot configure us (its `layoutOf()` recognises
 * only `llm-deepseek` and `llm-pi-ai`, so it shows "Other fields live in
 * settings.yaml" and disables Apply), and it reports "Model 1: Model ID is
 * required" because our `models` is an allowlist of ids where it expects model
 * objects.
 *
 * A *link* to the settings screen is not available: the settings dialog's open
 * state and active section are component-local React state in
 * `dsh-client-ui-settings-general` — no store, no service, no hash handling — so
 * no plugin can navigate it. What this card can do instead is name the exact
 * location and put the one control that page exists for (the key) right here.
 *
 * @module @gitawego/dsh-llm-provider/client/models-page
 */
import type { CardSnapshot } from './controller.ts'

/**
 * The one-line state summary the card shows.
 *
 * Pure and separate from the view so the wording is testable, and so the numbers
 * come from the same snapshot the section renders — the two surfaces cannot
 * disagree about how many models are allowed.
 * @param card - the route's snapshot.
 * @param t - copy lookup.
 * @returns the summary line.
 */
export function providerSummary(card: CardSnapshot, t: (key: 'modelsPageSummary' | 'on' | 'off') => string): string {
    return t('modelsPageSummary')
        .replace('{allowed}', String(card.advertisedCount))
        .replace('{served}', String(card.servedCount))
        .replace('{routing}', card.sessionRouting ? t('on') : t('off'))
}
