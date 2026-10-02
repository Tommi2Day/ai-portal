import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { t, useLang } from './i18n';
import { LangSwitch } from './LangSwitch';
import { Login } from './Login';
import { Chat } from './Chat';
import { McpSettings } from './McpSettings';
import { Admin } from './Admin';
import { Brand } from './Brand';
import { Articles } from './Articles';
import { Profile } from './Profile';
import { pluginPages } from './plugins';

type View = 'chat' | 'articles' | 'mcp' | 'admin' | `plugin:${string}`;
interface PluginInfo { id: string; name: string; description: string; hasPage: boolean; enabled: boolean }

export function App() {
  useLang();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>('chat');
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginError, setPluginError] = useState('');

  const load = () => api<Me>('/auth/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { load(); }, []);
  const loadPlugins = () => api<PluginInfo[]>('/plugins').then((list) => { setPlugins(list); setPluginError(''); })
    .catch((e: Error) => setPluginError(e.message));
  useEffect(() => {
    if (!me) { setPlugins([]); return; }
    void loadPlugins();
    const refresh = () => { void loadPlugins(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [me?.id]);
  useEffect(() => {
    if (view.startsWith('plugin:') && !plugins.some((p) => p.id === view.slice(7))) setView('chat');
  }, [plugins, view]);

  if (me === undefined) return null;
  if (me === null) return <Login onDone={load} />;

  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setMe(null); setView('chat'); };
  if (me.profileCompleted === false) return <Profile me={me} onDone={setMe} onLogout={logout} />;
  const selectedPlugin = view.startsWith('plugin:') ? plugins.find((p) => p.id === view.slice(7) && p.hasPage) : undefined;
  const PluginPage = selectedPlugin ? pluginPages[selectedPlugin.id] : undefined;

  return (
    <div className="shell">
      <header className="topbar">
        <strong><Brand /></strong>
        <nav>
          <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>{t('Chat')}</button>
          <button className={view === 'articles' ? 'active' : ''} onClick={() => setView('articles')}>{t('Artikel beitragen')}</button>
          <button className={view === 'mcp' ? 'active' : ''} onClick={() => setView('mcp')}>{t('MCP-Server')}</button>
          {plugins.filter((p) => p.hasPage && pluginPages[p.id]).map((p) => (
            <button key={p.id} className={view === `plugin:${p.id}` ? 'active' : ''} onClick={() => setView(`plugin:${p.id}`)}>{t(p.name)}</button>
          ))}
          {me.role === 'admin' && <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>{t('Administration')}</button>}
        </nav>
        <LangSwitch />
        <span className="muted">{me.displayName ?? me.username}</span>
        <button className="ghost" onClick={logout}>{t('Abmelden')}</button>
      </header>
      {/* useLang() above re-renders the whole tree on a language switch; state (open chat, forms) is kept */}
      <main className="main">
        {pluginError && <p className="notice" role="alert">{pluginError}</p>}
        {view === 'chat' && <Chat />}
        {view === 'articles' && <Articles />}
        {view === 'mcp' && <McpSettings />}
        {PluginPage && <PluginPage />}
        {view === 'admin' && <Admin me={me} onPluginsChanged={() => { void loadPlugins(); }} />}
      </main>
    </div>
  );
}
