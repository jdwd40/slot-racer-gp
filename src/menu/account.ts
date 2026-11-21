// The account and career screens (#141, moved out of src/main.ts unchanged): the title's sign-in link, the sign-in /
// create-account / profile screen, the signed-in driver's career and the local-races career note. createAccount is called
// once by src/main.ts with the overlay, the account client, the hub state it reads and writes (through accessors: the state
// stays in main.ts) and the actions it calls.
import * as R from '../records';
import { t } from '../i18n';
import { lengthOr } from '../raceLength';
import { setupOr } from '../carSetup';
import { escHtml } from '../hud';
import { LIMITS, type CareerStats } from '../net/protocol';
import type { AccountClient, AuthError } from '../net/account';
import type { NetSession } from '../net/session';
import { lengthName, setupChip } from './controls';
import type { Screen } from './types';

/** Text from other people (driver names, room codes) is always escaped before it goes into markup. */
const esc = escHtml;
function acctErrorText(e: AuthError, detail?: string): string {
  if (e === 'invalid_name') return t(`acct.err.name.${detail === 'too_long' || detail === 'reserved' || detail === 'blank' ? detail : 'other'}`);
  return t(`acct.err.${e}`);
}

const fmtDate = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
const careerMode = (m: string): string => t(`career.mode.${m}`);

function careerHtml(s: CareerStats): string {
  const c = s.career;
  const tile = (v: number | string, label: string, id: string): string => `<div class="tile" data-k="${id}"><b class="mono">${v}</b><small>${label}</small></div>`;
  const bests = s.bests.length ? `<div class="tscroll"><table><thead><tr><th>${t('career.circuit')}</th><th>${t('career.mode')}</th><th>${t('res.best')}</th></tr></thead><tbody>${s.bests.map((b) => `<tr data-mode="${b.mode}" data-setup="${setupOr(b.setup)}"><td>${t(`track.${b.track}.name`)}${b.current ? '' : ` <small>(${t(b.tuningCurrent === false ? 'career.oldTuning' : 'career.oldLayout')})</small>`}</td><td>${careerMode(b.mode)} ${setupChip(b.setup)}</td><td class="mono">${R.fmtMs(b.lapMs)} <small>${t('career.lapN', { n: b.lap })} · ${fmtDate(b.setAt)}</small></td></tr>`).join('')}</tbody></table></div>` : `<p><small>${t('career.noBests')}</small></p>`;
  const recent = s.recent.length ? `<div class="tscroll"><table><thead><tr><th>${t('career.date')}</th><th>${t('career.mode')}</th><th>${t('career.circuit')}</th><th>#</th><th>${t('champ.points')}</th></tr></thead><tbody>${s.recent.map((x) => `<tr data-race="${esc(x.raceId)}"><td>${fmtDate(x.finishedAt)}</td><td>${careerMode(x.mode)}${x.championship ? ` <small>R${x.championship.round}</small>` : ''} <small class="len">${lengthName(lengthOr(x.length))}</small> ${setupChip(x.setup)}</td><td>${t(`track.${x.track}.name`)}</td><td>${x.status === 'dq' ? t('res.dq') : x.status === 'dnf' ? t('res.dnf') : `P${x.pos}/${x.field}`}</td><td class="mono">${x.points}</td></tr>`).join('')}</tbody></table></div>` : `<p><small>${t('career.noRaces')}</small></p>`;
  return `<h3>${t('career.title')} · <span class="nm">${esc(s.displayName)}</span></h3>
    <div class="tiles">${tile(c.points, t('career.points'), 'points')}${tile(c.wins, '🥇', 'wins')}${tile(c.seconds, '🥈', 'seconds')}${tile(c.thirds, '🥉', 'thirds')}${tile(c.races, t('career.races'), 'races')}</div>
    <p><small>${t('career.policy', { a: s.scoring.podium[0] ?? 0, b: s.scoring.podium[1] ?? 0, c: s.scoring.podium[2] ?? 0 })}</small></p>
    <h3>${t('career.bests')}</h3>${bests}
    <h3>${t('career.recent')}</h3>${recent}`;
}

/** What the account and career screens use from the hub (src/main.ts). */
export interface AccountDeps {
  readonly overlay: HTMLElement;
  readonly accounts: AccountClient;
  readonly screen: Screen;
  readonly net: NetSession | null;
  acctNotice: string;
  accountsOn(): boolean;
  enter(s: Screen): void;
  showTitle(): void;
  onIdentityChanged(): void;
}

/** The account and career screens bound to the hub: called once by src/main.ts. */
export function createAccount(hub: AccountDeps) {
  const { overlay, accounts, accountsOn, enter, showTitle, onIdentityChanged } = hub;
  function accountEntryHtml(): string {
    if (!accountsOn()) return '';
    const a = accounts.auth;
    if (a.state === 'loading') return `<button class="linkbtn" id="o-account" disabled aria-busy="true">${t('acct.loading')}</button>`;
    if (a.state === 'unavailable') return `<button class="linkbtn" id="o-account">${t('acct.unavailableShort')}</button>`;
    // the display name is the driver's own public name; other people's text is always escaped
    if (a.state === 'signed-in') return `<button class="linkbtn" id="o-account" aria-label="${t('acct.profile')}">👤 <span class="nm">${esc(a.account.displayName)}</span></button>`;
    return `<button class="linkbtn" id="o-account">${t('acct.signIn')}</button>`;
  }

  /** Sign in, create an account, or (signed in) edit the driver name and sign out. Built for phone keyboards: real forms, Enter submits. */
  function showAccount(tab: 'login' | 'register' = 'login'): void {
    if (!accountsOn() || hub.net) { showTitle(); return; }
    enter('account');
    overlay.className = 'overlay show';
    const a = accounts.auth;
    const field = (id: string, label: string, attrs: string): string =>
      `<label class="acct-field" for="${id}"><span class="lbl2">${t(label)}</span><input id="${id}" ${attrs} spellcheck="false" autocorrect="off"></label>`;
    let body: string;
    if (a.state === 'signed-in') {
      body = `<h2>${t('acct.profile')}</h2>
        <p class="acct-who">${t('acct.signedInAs')} <b class="mono" id="a-user"></b></p>
        <p><small>${t('acct.privateNote')}</small></p>
        <form id="a-form" class="acct-form" novalidate>
          ${field('a-name', 'acct.driverName', `maxlength="${LIMITS.nameMax * 2}" autocomplete="nickname" enterkeyhint="done" required`)}
          <small>${t('acct.nameRules', { n: LIMITS.nameMax })}</small>
          <button class="cta" type="submit" id="a-submit">${t('acct.save')}</button>
        </form>
        <p id="a-msg" class="net-msg" role="status" aria-live="polite"></p>
        <section class="career" id="a-career" aria-busy="true" aria-live="polite"><h3>${t('career.title')}</h3><p><small>${t('career.loading')}</small></p></section>
        <div class="row"><button class="cta alt" id="a-logout" type="button">${t('acct.signOut')}</button><button class="cta alt" id="a-back" type="button">${t('boards.back')}</button></div>`;
    } else if (a.state === 'loading' || a.state === 'unavailable') {
      body = `<h2>${t('acct.title')}</h2><p id="a-msg" class="net-msg" role="status" aria-live="polite">${t(a.state === 'loading' ? 'acct.loading' : 'acct.unavailable')}</p>
        <div class="row">${a.state === 'unavailable' ? `<button class="cta" id="a-retry" type="button">${t('acct.retry')}</button>` : ''}<button class="cta alt" id="a-back" type="button">${t('boards.back')}</button></div>`;
    } else {
      const reg = tab === 'register';
      body = `<h2>${t('acct.title')}</h2>
        <div class="tabs" role="tablist"><button class="tab ${reg ? '' : 'sel'}" role="tab" aria-selected="${!reg}" id="a-tab-login" type="button">${t('acct.signIn')}</button><button class="tab ${reg ? 'sel' : ''}" role="tab" aria-selected="${reg}" id="a-tab-register" type="button">${t('acct.create')}</button></div>
        <form id="a-form" class="acct-form" novalidate data-kind="${reg ? 'register' : 'login'}">
          ${field('a-user-in', 'acct.username', `maxlength="20" autocomplete="username" autocapitalize="none" enterkeyhint="next" required`)}
          ${reg ? `<small>${t('acct.userRules')}</small>` : ''}
          ${field('a-pass', 'acct.password', `type="password" maxlength="128" autocomplete="${reg ? 'new-password' : 'current-password'}" enterkeyhint="${reg ? 'next' : 'go'}" required`)}
          ${reg ? `<small>${t('acct.passRules')}</small>${field('a-name', 'acct.driverNameOpt', `maxlength="${LIMITS.nameMax * 2}" autocomplete="nickname" enterkeyhint="go"`)}<small>${t('acct.nameRules', { n: LIMITS.nameMax })}</small>` : ''}
          <button class="cta" type="submit" id="a-submit">${t(reg ? 'acct.create' : 'acct.signIn')}</button>
        </form>
        <p id="a-msg" class="net-msg" role="status" aria-live="polite"></p>
        <p><small>${t('acct.noEmail')}</small></p>
        <div class="row"><button class="cta alt" id="a-back" type="button">${t('boards.back')}</button></div>`;
    }
    overlay.innerHTML = `<div class="card account">${body}</div>`;
    const msg = overlay.querySelector<HTMLElement>('#a-msg')!;
    msg.textContent = hub.acctNotice || msg.textContent;
    hub.acctNotice = '';
    const say2 = (text: string, kind: 'err' | 'ok' | 'busy'): void => { msg.textContent = text; msg.dataset.kind = kind; };
    overlay.querySelector('#a-back')!.addEventListener('click', () => { if (!accounts.busy) showTitle(); });
    overlay.querySelector('#a-retry')?.addEventListener('click', () => { void accounts.restore().then(() => { if (hub.screen === 'account') showAccount(); }); showAccount(); });
    overlay.querySelector('#a-tab-login')?.addEventListener('click', () => showAccount('login'));
    overlay.querySelector('#a-tab-register')?.addEventListener('click', () => showAccount('register'));
    const form = overlay.querySelector<HTMLFormElement>('#a-form');
    const inputs = [...overlay.querySelectorAll<HTMLInputElement>('#a-form input')];
    const setBusy = (on: boolean, label: string): void => {
      overlay.querySelectorAll<HTMLButtonElement>('.account button').forEach((b) => { b.disabled = on; });
      inputs.forEach((i) => { i.readOnly = on; });
      form?.setAttribute('aria-busy', String(on));
      if (on) say2(label, 'busy');
    };
    const invalid = (el: HTMLInputElement | null, text: string): void => { say2(text, 'err'); if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } };
    inputs.forEach((i) => i.addEventListener('input', () => i.removeAttribute('aria-invalid')));
    if (a.state === 'signed-in') {
      overlay.querySelector('#a-user')!.textContent = a.account.username;
      loadCareer(a.account.id);
      const nameEl = overlay.querySelector<HTMLInputElement>('#a-name')!;
      nameEl.value = a.account.displayName;
      form!.addEventListener('submit', (e) => {
        e.preventDefault();
        if (accounts.busy) return;
        setBusy(true, t('acct.saving'));
        void accounts.rename(nameEl.value).then((r) => {
          if (hub.screen !== 'account') return;
          if (r.ok) { showAccount(); say2(t('acct.saved'), 'ok'); return; }
          if (r.error === 'session_expired' || r.error === 'signed_out') { showAccount(); return; }
          // signed out and in again in another tab: nothing was saved, and the screen now shows who this browser really is
          if (r.error === 'identity_changed') { onIdentityChanged(); hub.acctNotice = t('acct.err.identity_changed'); showAccount(); return; }
          setBusy(false, '');
          invalid(nameEl, acctErrorText(r.error, r.detail));
        });
      });
      overlay.querySelector('#a-logout')!.addEventListener('click', () => {
        if (accounts.busy) return;
        setBusy(true, t('acct.signingOut'));
        void accounts.logout().then((r) => {
          onIdentityChanged();
          if (hub.screen !== 'account') return;
          if (r.ok) { hub.acctNotice = t('acct.signedOut'); showAccount(); return; }
          // the server has not revoked the session: this device is still signed in
          setBusy(false, '');
          say2(t(r.error === 'unreachable' ? 'acct.err.signOutUnreachable' : 'acct.err.signOutFailed'), 'err');
        });
      });
    } else if (form) {
      const reg = form.dataset.kind === 'register';
      const user = overlay.querySelector<HTMLInputElement>('#a-user-in')!, pass = overlay.querySelector<HTMLInputElement>('#a-pass')!;
      const nameEl = overlay.querySelector<HTMLInputElement>('#a-name');
      user.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pass.focus(); } });
      if (reg) pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl?.focus(); } });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (accounts.busy) return;
        if (!/^[A-Za-z0-9_-]{3,20}$/.test(user.value.trim())) { invalid(user, t('acct.err.invalid_username')); return; }
        const n = [...pass.value].length;
        if (reg ? n < 10 || n > 128 : !n) { invalid(pass, t(reg ? 'acct.err.invalid_password' : 'acct.err.passwordRequired')); return; }
        setBusy(true, t(reg ? 'acct.creating' : 'acct.signingIn'));
        const go = reg ? accounts.register(user.value, pass.value, nameEl?.value ?? '') : accounts.login(user.value, pass.value);
        void go.then((r) => {
          if (hub.screen !== 'account') return;
          if (r.ok) { onIdentityChanged(); hub.acctNotice = t(reg ? 'acct.created' : 'acct.welcome', { name: r.account.displayName }); showAccount(); return; }
          // the account was created but the server could not sign it in: send the driver to sign in (registering again would
          // only say the name is taken), with the username filled in
          if (reg && r.error === 'unavailable' && r.detail === 'account_created') {
            const name = user.value.trim();
            hub.acctNotice = t('acct.err.createdNotSignedIn');
            showAccount('login');
            const u = overlay.querySelector<HTMLInputElement>('#a-user-in');
            if (u) u.value = name;
            return;
          }
          setBusy(false, '');
          pass.value = '';
          invalid(r.error === 'invalid_name' ? nameEl : r.error === 'username_taken' || r.error === 'invalid_username' ? user : pass, acctErrorText(r.error, r.detail));
        });
      });
      if (!('ontouchstart' in window)) user.focus({ preventScroll: true });
    }
  }

  /** Local and offline races never earn account points: said wherever the server could have offered them. */
  function localCareerNote(): string {
    if (!accountsOn()) return '';
    return `<p class="career-note"><small>${t(accounts.account ? 'career.localNote' : 'career.localNoteGuest')}</small></p>`;
  }

  /** The signed-in driver's career from the server, rendered into the profile once it arrives (for that account only). */
  function loadCareer(accountId: string): void {
    void accounts.stats().then((r) => {
      const el = overlay.querySelector<HTMLElement>('#a-career');
      if (hub.screen !== 'account' || !el || accounts.account?.id !== accountId) return;
      el.removeAttribute('aria-busy');
      el.innerHTML = r.ok ? careerHtml(r.stats) : `<h3>${t('career.title')}</h3><p><small>${t(`acct.err.${r.error}`)}</small></p>`;
    });
  }

  return { accountEntryHtml, showAccount, localCareerNote, loadCareer };
}
