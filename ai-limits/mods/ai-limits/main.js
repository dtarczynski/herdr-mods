import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, knownAgents, shared, setShared, run, layout, nextCommand } from "herdr";

const COMPACT = 'ai-limits.compact.v1';
function findBlock(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children || []) { const found = findBlock(child, id); if (found) return found; }
  return null;
}

export default class AiLimits extends View {
  init(_props, cx) {
    this.data = null;
    this.busy = false;
    this.other = [];
    this.supported = []; this.detecting = true;
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === 'compact' || command === 'normal') setShared(COMPACT, command === 'compact');
        cx.notify();
      }
    });
    this.discover(cx);
    cx.timer.every(300000, cx => this.discover(cx));
  }
  discover(cx) {
    if (this.discovering) return;
    this.discovering = true;
    cx.spawn(async cx => {
      try {
        const agents = await knownAgents();
        let extra = [];
        try {
          const r = await exec('python3', [appHome() + '/mods/ai-limits/usage.py', '--discover'], {timeout:3000});
          if (r.code === 0) extra = JSON.parse(r.stdout).providers || [];
        } catch (_) {}
        this.brandIcons = Object.fromEntries(agents.map(a => [a.name, {icon:a.icon, tint:a.tint}]));
        const names = [...new Set([...agents.filter(a => a.installed && a.agent).map(a => /codex/i.test(a.key || a.name) ? 'Codex' : /claude/i.test(a.key || a.name) ? 'Claude' : /antigravity|^agy$/i.test(a.key || a.name) ? 'Antigravity' : /gemini/i.test(a.key || a.name) ? 'Gemini' : a.name).filter(Boolean), ...extra])];
        this.supported = names.filter(name => ['Codex', 'Claude', 'Gemini', 'Antigravity'].includes(name));
        this.other = names.filter(name => !this.supported.includes(name));
        this.discoveryError = null; this.detecting = false;
        this.refresh(cx);
      } catch (_) { this.discoveryError = 'Could not detect installed agents'; this.detecting = false; }
      finally { this.discovering = false; }
      cx.notify();
    });
  }
  enabled(name) {
    const disabled = shared("ai-limits.disabled.v1");
    return !Array.isArray(disabled) || !disabled.includes(name);
  }
  refresh(cx) {
    if (this.busy || (this.lastAttempt && Date.now() - this.lastAttempt < 60000)) return;
    this.lastAttempt = Date.now();
    this.busy = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await exec('python3', [appHome() + '/mods/ai-limits/usage.py', ...this.supported.filter(name => this.enabled(name))], {timeout: 25000});
        if (r.code !== 0) throw new Error('read');
        this.data = JSON.parse(r.stdout);
      } catch (_) {
        this.data = {providers: this.supported.filter(name => this.enabled(name)).map(name => ({name, error:'Usage unavailable'}))};
      } finally { this.busy = false; cx.notify(); }
    });
  }
  reset(value) {
    if (!value) return 'Reset: unavailable';
    const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (!Number.isFinite(d.getTime())) return 'Reset: unavailable';
    if (d.getTime() <= Date.now()) return 'Reset passed · refresh usage';
    const pad = n => String(n).padStart(2, '0');
    return `Reset ${pad(d.getDate())}.${pad(d.getMonth()+1)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  providerLabel(name) {
    const t = theme();
    const defaults = {
      Codex: {icon: 'icons/codex.svg', tint: false},
      Claude: {icon: 'icons/claude.svg', tint: false},
      OpenCode: {icon: 'icons/opencode.svg', tint: true},
      Gemini: {icon: 'icons/gemini.svg', tint: true},
      Antigravity: {icon: 'icons/antigravity.svg', tint: true}
    };
    const brand = this.brandIcons?.[name] || defaults[name];
    const row = h_flex().items_center().gap(7);
    if (brand?.icon) row.child(brand.tint
      ? svg(brand.icon).size(16).flex_none().text_color(name === 'Gemini' ? t.ansi4 : t.foreground)
      : image(brand.icon).w(16).h(16).flex_none());
    return row.child(div().child(name));
  }
  render() {
    const t = theme(), compact = shared(COMPACT) === true;
    const readings = this.data?.providers || [];
    const block = findBlock(layout(), 'ai-limits'), layoutName = shared('layout') || 'current';
    if (block) {
      const saved = shared('ai-limits.normal-sizes.v1') || {};
      if (compact) {
        if (this.compactMode === false || !saved[layoutName]) setShared('ai-limits.normal-sizes.v1', {...saved, [layoutName]: block.size || {px:300}});
        const rows = this.supported.filter(name => this.enabled(name)).reduce((sum, name) => sum + Math.max(1, readings.find(p => p.name === name)?.windows?.length || 0), 0);
        const other = this.other.filter(name => this.enabled(name)).length;
        const height = Math.min(440, Math.max(94, 48 + rows * 38 + other * 42));
        if (this.compactMode !== true || this.compactHeight !== height) run('layout.resize', {id:'ai-limits', px:height});
        this.compactHeight = height;
      } else if (this.compactMode === true) run('layout.resize', {id:'ai-limits', ...(saved[layoutName] || {px:300})});
    }
    this.compactMode = compact;
    const root = v_flex().id('ai-limits').size_full().overflow_y_scroll().p(compact ? 10 : 14).gap(compact ? 8 : 12).bg(t.chrome).border_t(1).border_color(t.border).text_size(12).text_color(t.foreground);
    root.child(h_flex().items_center().justify_between()
      .child(div().child('AI Limits'))
      .child(h_flex().gap(12).items_center()
      .child(div().id('limits-settings').text_color(t.muted).cursor_pointer().tooltip('AI Limits settings').on_click(() => run('mod.open', {name:'ai-limits-settings'})).child('⚙'))
      .child(div().id('limits-refresh').text_color(t.muted).cursor_pointer().tooltip('Refresh (once per minute); automatic refresh every 5 min').on_click((_e,cx) => this.discover(cx)).child(this.busy ? 'Loading…' : '↻'))));
    if (!compact) root.child(div().text_size(10).text_color(t.dim).child('Usage · local account'));
    for (const name of this.supported) {
      if (!this.enabled(name)) continue;
      const p = readings.find(p => p.name === name) || {name, error: this.busy ? 'Loading…' : 'Click ↻ to load usage'};
      const card = v_flex().gap(compact ? 4 : 6);
      if (!compact || p.error || !p.windows?.length) card.child(this.providerLabel(p.name));
      if (p.error || !p.windows) card.child(div().text_size(11).text_color(t.muted).child(p.error || 'Loading…'));
      for (const [index, w] of (p.windows || []).entries()) {
        const expired = w.reset && (typeof w.reset === 'number' ? w.reset * 1000 : Date.parse(w.reset)) <= Date.now();
        const color = expired ? t.dim : w.used >= 90 ? t.ansi1 : w.used >= 70 ? t.ansi3 : t.ansi2;
        card.child(v_flex().gap(3).tooltip(`${p.name} · ${w.label} · ${Math.round(w.used)}% used · ${this.reset(w.reset)}`)
          .child(h_flex().gap(8).items_center()
            .when(compact && index === 0, el => el.child(this.providerLabel(p.name)))
            .child(div().flex_1().min_w(0).truncate().text_size(compact ? 10 : 12).text_color(t.muted).child(w.label))
            .child(div().flex_none().text_color(color).child(`${Math.round(w.used)}%`)))
          .child(div().w_full().h(compact ? 4 : 5).rounded(3).bg(t.border).child(div().w(`${w.used}%`).h(compact ? 4 : 5).rounded(3).bg(color)))
          .when(!compact, el => el.child(div().text_size(10).text_color(t.dim).child(this.reset(w.reset)))));
      }
      root.child(card);
    }
    for (const name of this.other.filter(name => this.enabled(name))) root.child(v_flex().gap(3).child(this.providerLabel(name)).child(div().text_size(10).text_color(t.dim).child('Usage integration unavailable')));
    if (this.discoveryError || this.detecting) root.child(div().text_color(t.muted).child(this.discoveryError || 'Detecting installed agents…'));
    else if (![...this.supported, ...this.other].length) root.child(div().text_color(t.muted).child('No installed agents detected.'));
    else if (![...this.supported, ...this.other].some(name => this.enabled(name))) root.child(div().text_color(t.muted).child('All services disabled. Enable them in ⚙.'));
    return root;
  }
}
