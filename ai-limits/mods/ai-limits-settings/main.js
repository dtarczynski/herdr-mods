import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, shared, setShared, props, closeOverlay, knownAgents, exec, appHome } from "herdr";

const KEY = 'ai-limits.disabled.v1';
export default class LimitsSettings extends View {
  init(_props, cx) {
    this.names = []; this.detecting = true;
    cx.spawn(async cx => {
      try {
        const agents = await knownAgents();
        let extra = [];
        try {
          const r = await exec('python3', [appHome() + '/mods/ai-limits/usage.py', '--discover'], {timeout:3000});
          if (r.code === 0) extra = JSON.parse(r.stdout).providers || [];
        } catch (_) {}
        this.brandIcons = Object.fromEntries(agents.map(a => [a.name, {icon:a.icon, tint:a.tint}]));
        this.names = [...new Set([...agents.filter(a => a.installed && a.agent).map(a => /codex/i.test(a.key || a.name) ? 'Codex' : /claude/i.test(a.key || a.name) ? 'Claude' : /antigravity|^agy$/i.test(a.key || a.name) ? 'Antigravity' : /gemini/i.test(a.key || a.name) ? 'Gemini' : a.name).filter(Boolean), ...extra])];
      } catch (_) { this.error = 'Could not detect installed agents. Reopen settings to retry.'; }
      finally { this.detecting = false; cx.notify(); }
    });
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
    const t = theme();
    const value = shared(KEY);
    const disabled = Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
    const compact = shared('ai-limits.compact.v1') === true;
    return v_flex().size_full().p(20).gap(16).bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().justify_between().items_center().child('AI Limits settings')
        .child(div().id('close-settings').p(4).cursor_pointer().tooltip('Close').child('×').on_click(() => closeOverlay(props().overlay))))
      .child(h_flex().id('compact-view').p(8).rounded(6).justify_between().items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .on_click(() => setShared('ai-limits.compact.v1', shared('ai-limits.compact.v1') !== true))
        .child(div().child('Compact view'))
        .child(div().w(64).py(4).rounded(12).text_center().text_size(11).bg(compact ? t.accent : t.border).text_color(compact ? t.accent_foreground : t.muted).child(compact ? 'On' : 'Off')))
      .child(div().text_size(11).text_color(t.muted).child('Choose services to show in the widget.'))
      .when(this.detecting || Boolean(this.error) || !this.names.length, el => el.child(div().text_size(11).text_color(t.muted).child(this.error || (this.detecting ? 'Detecting installed agents…' : 'No installed agents detected.'))))
      .child(v_flex().gap(8).flex_1().overflow_y_scroll().id('provider-toggles').children(this.names.map(name => {
        const enabled = !disabled.includes(name);
        return h_flex().id(`toggle-${name}`).p(8).rounded(6).justify_between().items_center().cursor_pointer().hover(s => s.bg(t.hover))
          .tooltip(`${enabled ? 'Disable' : 'Enable'} ${name}`)
          .on_click(() => {
            const current = shared(KEY);
            const off = Array.isArray(current) ? current.filter(x => typeof x === 'string') : [];
            setShared(KEY, off.includes(name) ? off.filter(x => x !== name) : [...off, name]);
          })
          .child(this.providerLabel(name))
          .child(div().w(64).py(4).rounded(12).text_center().text_size(11).bg(enabled ? t.accent : t.border).text_color(enabled ? t.accent_foreground : t.muted).child(enabled ? 'On' : 'Off'));
      })))
      .child(div().text_size(10).text_color(t.dim).child('Saved automatically. Disabled services are not queried.'));
  }
}
