// Branding injected by the server into index.html (PORTAL_NAME, PORTAL_LOGO); defaults in `vite dev`.
const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;

export const portalName = meta('portal-name') ?? 'AI Portal';
const portalLogo = meta('portal-logo');

export function Brand() {
  return (
    <span className={portalLogo ? 'brand has-logo' : 'brand'}>
      {portalLogo && <img className="brand-logo" src={portalLogo} alt="" />}
      <span className="brand-name">{portalName}</span>
    </span>
  );
}
