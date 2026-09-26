import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { t, useLang } from './i18n';
import { LangSwitch } from './LangSwitch';
import { Login } from './Login';
import { Chat } from './Chat';
import { McpSettings } from './McpSettings';
import { Admin } from './Admin';

type View = 'chat' | 'mcp' | 'admin';

export function App() {
  useLang();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [view, setView] = useState<View>('chat');

  const load = () => api<Me>('/auth/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { load(); }, []);

  if (me === undefined) return null;
  if (me === null) return <Login onDone={load} />;

  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setMe(null); };

  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">AI Portal</strong>
        <nav>
          <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>{t('Chat')}</button>
          <button className={view === 'mcp' ? 'active' : ''} onClick={() => setView('mcp')}>{t('MCP-Server')}</button>
          {me.role === 'admin' && <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>{t('Administration')}</button>}
        </nav>
        <LangSwitch />
        <span className="muted">{me.displayName ?? me.username}</span>
        <button className="ghost" onClick={logout}>{t('Abmelden')}</button>
      </header>
      {/* useLang() above re-renders the whole tree on a language switch; state (open chat, forms) is kept */}
      <main className="main">
        {view === 'chat' && <Chat />}
        {view === 'mcp' && <McpSettings />}
        {view === 'admin' && <Admin me={me} />}
      </main>
    </div>
  );
}
