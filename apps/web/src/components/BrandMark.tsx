import "./brand.css";

/** The FilsPay mark: a pearl (Bahrain's pearling heritage) beside the
 *  wordmark. Pure SVG, so it needs no image request and suits the CSP. */
export function BrandMark({ tagline }: { tagline?: string }) {
  return (
    <span className="fp-brand">
      <svg className="fp-brand-pearl" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <radialGradient id="fp-pearl" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="45%" stopColor="#f1e9dc" />
            <stop offset="100%" stopColor="#c8a96a" />
          </radialGradient>
        </defs>
        <circle cx="16" cy="16" r="13" fill="url(#fp-pearl)" />
        <circle cx="11.5" cy="11" r="3.2" fill="#fff" opacity="0.85" />
      </svg>
      <span className="fp-brand-text">
        <span className="fp-brand-name">
          Fils<b>Pay</b>
        </span>
        {tagline ? <span className="fp-brand-tagline">{tagline}</span> : null}
      </span>
    </span>
  );
}
