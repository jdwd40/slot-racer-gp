// Post-race debrief card (#134): renders one driver's summary (src/debrief.ts) for the local results, a championship round
// and the online results. Text only from the strings table; every figure from the summary or the classification. A missing
// summary (an older server's result) is shown as unavailable, never as zeros, and then there is no takeaway.
import { t } from './i18n';
import { takeaway, type DriverDebrief, type PbCompare, type ResultFacts } from './debrief';

export interface DebriefCard {
  /** the summary, or null when this result has none (unavailable) */
  d: DriverDebrief | null;
  facts: ResultFacts & { pos: number | null };
  /** circuit, race length and setup, already in words */
  where: string;
  /** a compatible pre-race personal best compared, or null (no baseline: no comparison shown) */
  pb: PbCompare | null;
  /** expanded at first (wide screens); a phone shows the summary line and the takeaway, the breakdown one tap away */
  open: boolean;
}

const s3 = (x: number): string => x.toFixed(3);
const s1 = (x: number): string => x.toFixed(1);
const row = (k: string, label: string, body: string): string => `<div class="deb-row" data-k="${k}"><dt>${label}</dt><dd>${body}</dd></div>`;
const small = (x: string): string => `<small>${x}</small>`;

/** The result line: position or DQ/DNF with its reason, and where and how it was raced. */
function resultText(f: DebriefCard['facts'], where: string): string {
  const res = f.status === 'dq' ? `${t('res.dq')} · ${t(`res.dqReason.${f.dqReason ?? 'deadline'}`)}`
    : f.status === 'dnf' ? `${t('res.dnf')} · ${t(`net.dnf.${f.dnfReason ?? 'runout'}`)}`
    : f.status === 'finished' && f.pos ? `P${f.pos}` : t('deb.running');
  return `${res} <small>· ${where}</small>`;
}

/** The debrief block for one driver (HTML). */
export function debriefHtml(c: DebriefCard): string {
  const { d, facts: f, pb } = c;
  const title = `<b class="deb-title">${t('deb.title')}</b>`;
  if (!d) {
    return `<div class="debrief" data-debrief="none">${title} <span class="deb-res">${resultText(f, c.where)}</span><p class="deb-none">${small(t('deb.unavailable'))}</p></div>`;
  }
  const tk = takeaway(d, f, pb);
  const tkHtml = tk ? `<span class="deb-tk" data-tk="${tk.id}">${t(tk.id, tk.vars)}</span>` : '';
  const pace = d.best !== null
    ? `${t('deb.paceBest', { best: s3(d.best), lap: d.bestLap ?? 0 })} · ${t('deb.paceMean', { mean: s3(d.mean ?? 0) })} · ${t('deb.paceValid', { n: d.valid, laps: d.laps })}`
    : `— ${small(t('deb.paceNone', { laps: d.laps }))}`;
  const cons = d.sd !== null ? `±${s3(d.sd)} s ${small(t('deb.consHelp'))}` : `— ${small(t('deb.consNone'))}`;
  const pbRow = pb ? row('pb', t('deb.pb'), pb.improved ? `<span class="deb-new">${t('deb.pbNew', { d: s3(-pb.delta) })}</span> ${small(t('deb.pbWas', { was: s3(pb.before / 1000) }))}`
    : pb.delta === 0 ? t('deb.pbEqual', { was: s3(pb.before / 1000) }) : t('deb.pbOff', { d: s3(pb.delta), was: s3(pb.before / 1000) })) : '';
  const inc = [
    t('deb.incDeslots', { n: d.deslots }) + (d.deslots ? ` ${small(t('deb.incOff', { s: s1(d.offS) }))}` : ''),
    t('deb.incOffences', { n: d.offences }),
    t('deb.incHitBy', { n: d.hitBy }),
    t('deb.incTows', { n: d.tows }),
    t('deb.incStalls', { n: d.recoveries }),
  ].join(' · ');
  const p = d.pit;
  const parts = [p.bayS > 0 ? t('deb.pitBay', { s: s1(p.bayS) }) : '', p.serveS > 0 ? t('deb.pitServe', { s: s1(p.serveS) }) : '', p.queueS > 0 ? t('deb.pitQueue', { s: s1(p.queueS) }) : ''].filter(Boolean);
  const pit = p.visits
    ? `${t('deb.pitVisits', { n: p.visits, fuel: p.fuel, other: p.visits - p.fuel })} · ${t('deb.pitTime', { s: s1(p.s) })}${parts.length ? ` ${small(t('deb.includes', { list: parts.join(', ') }))}` : ''}`
    : t('deb.pitNone');
  const fo = d.forced;
  const forced = d.tows || d.recoveries ? row('forced', t('deb.forced'), [
    d.tows ? `${t('deb.towTime', { n: d.tows, s: s1(fo.towS) })}${fo.penS > 0 ? ` ${small(t('deb.includes', { list: t('deb.towPen', { s: s1(fo.penS) }) }))}` : ''}` : '',
    d.recoveries ? t('deb.recTime', { n: d.recoveries, s: s1(fo.recS) }) : '',
  ].filter(Boolean).join(' · ')) : '';
  const pen = [
    d.stopGos ? t('deb.penSg', { n: d.stopGos, served: d.served }) : '',
    f.timePen > 0 ? t('deb.penTime', { n: f.timePen }) : '',
  ].filter(Boolean).join(' · ') || t('deb.penNone');
  const open = d.open ? `<p class="deb-open">${small(t(`deb.open.${d.open}`))}</p>` : '';
  return `<details class="debrief" data-debrief="ok"${c.open ? ' open' : ''}>
    <summary>${title} ${tkHtml}</summary>
    <dl class="deb-list">
      ${row('result', t('deb.result'), resultText(f, c.where))}
      ${row('pace', t('deb.pace'), pace)}
      ${row('cons', t('deb.cons'), cons)}
      ${pbRow}
      ${row('inc', t('deb.inc'), inc)}
      ${row('pit', t('deb.pit'), pit)}
      ${forced}
      ${row('pen', t('deb.pen'), pen)}
    </dl>
    ${open}<p class="deb-note">${small(t('deb.note'))}</p>
  </details>`;
}

/** Wide screens show the breakdown at once; on a phone (the compact layout) it starts folded under the takeaway. */
export function debriefOpen(): boolean {
  try { return !matchMedia('(max-width: 700px), (max-height: 500px)').matches; } catch { return true; }
}
