import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import yaml from 'js-yaml';
import { useI18n } from '../../i18n';
import { tryParseToml } from './configParsers';

interface Props {
  value: string;
  fileName?: string;
}

const MAX_STRING_CHARS = 80;
const DEFAULT_OPEN_DEPTH = 2;
const MAX_VISIBLE_ITEMS = 200;

function truncate(s: string): string {
  if (s.length <= MAX_STRING_CHARS) return s;
  return `${s.slice(0, MAX_STRING_CHARS)}…`;
}

// Keys that hold secrets — render masked so accidental screenshots don't leak.
const SECRET_KEY = /api[-_]?key|secret|token|password|credential|authorization/i;

function formatString(s: string, secret: boolean): string {
  if (secret) return `"${s.slice(0, 3)}••••${s.slice(-3)}"`;
  return `"${truncate(s)}"`;
}

interface NodeProps {
  name?: string;
  value: unknown;
  depth: number;
}

function JsonNode({ name, value, depth }: NodeProps) {
  const { t } = useI18n();
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object' && !isArray;
  const isCollapsible = isArray || isObject;

  // Default: objects/arrays nested deeper than DEFAULT_OPEN_DEPTH start
  // collapsed. Very large containers also collapse to keep the DOM light.
  const defaultOpen = !isCollapsible
    || (depth < DEFAULT_OPEN_DEPTH && !(isArray && (value as unknown[]).length > MAX_VISIBLE_ITEMS));
  const [open, setOpen] = useState(defaultOpen);

  if (!isCollapsible) {
    // Scalar leaf.
    let rendered: string;
    let cls = 'jtree-value';
    if (value === null) { rendered = 'null'; cls = 'jtree-null'; }
    else if (typeof value === 'boolean') { rendered = String(value); cls = 'jtree-bool'; }
    else if (typeof value === 'number') { rendered = String(value); cls = 'jtree-num'; }
    else if (typeof value === 'string') {
      rendered = formatString(value, name ? SECRET_KEY.test(name) : false);
      cls = 'jtree-str';
    } else {
      rendered = String(value);
    }
    return (
      <div className="jtree-row jtree-leaf" style={{ paddingLeft: depth * 18 }}>
        {name !== undefined && <span className="jtree-key">{name}: </span>}
        <span className={cls} title={typeof value === 'string' ? value : undefined}>{rendered}</span>
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const visible = entries.slice(0, MAX_VISIBLE_ITEMS);
  const overflow = entries.length - visible.length;
  const summary = `${entries.length} ${t('jtree.items')}`;
  const closeBracket = isArray ? ']' : '}';

  return (
    <div className="jtree-branch">
      <button
        type="button"
        className="jtree-toggle"
        style={{ paddingLeft: depth * 18 }}
        onClick={() => setOpen(o => !o)}
        title={open ? t('jtree.collapse') : t('jtree.expand')}
      >
        <span className={`jtree-caret${open ? ' open' : ''}`}><ChevronRight size={11} /></span>
        {name !== undefined && <span className="jtree-key">{name}: </span>}
        {isArray ? <span className="jtree-bracket">[</span> : <span className="jtree-bracket">{'{'}</span>}
        {!open && <><span className="jtree-summary">{summary}</span><span className="jtree-bracket">{closeBracket}</span></>}
      </button>
      {open && (
        <div className="jtree-children">
          {visible.map(([k, v]) => (
            <JsonNode key={k} name={k} value={v} depth={depth + 1} />
          ))}
          {overflow > 0 && (
            <div className="jtree-row jtree-more" style={{ paddingLeft: (depth + 1) * 18 }}>
              {t('jtree.more', { count: overflow })}
            </div>
          )}
          <div className="jtree-row jtree-bracket-close" style={{ paddingLeft: depth * 18 }}>
            <span className="jtree-bracket">{closeBracket}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Strip JSONC/JSON5 comments and trailing commas, then parse as JSON.
// Returns undefined when the result is still not valid JSON.
function tryParseJsonc(text: string): unknown | undefined {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

// The parser is chosen by the file's extension, never by trying formats in
// sequence: a YAML block can look like TOML (and vice versa), so blind
// fallbacks can silently render a wrong tree. Only the format the file claims
// gets a chance; anything that fails degrades to the raw text view.
function parseByExtension(base: string, text: string): { parsed?: unknown; error?: string } {
  const ext = base.match(/(\.[a-z0-9]+)$/i)?.[1]?.toLowerCase();
  switch (ext) {
    case '.json':
      try { return { parsed: JSON.parse(text) }; } catch { return { error: 'json' }; }
    case '.jsonc': case '.json5': {
      const parsed = tryParseJsonc(text);
      return parsed !== undefined ? { parsed } : { error: 'jsonc' };
    }
    case '.toml': {
      const parsed = tryParseToml(text);
      return parsed !== undefined ? { parsed } : { error: 'toml' };
    }
    case '.yaml': case '.yml':
      try { return { parsed: yaml.load(text) }; } catch { return { error: 'yaml' }; }
    default:
      // .env and unknown extensions stay raw text by design.
      return {};
  }
}

// Collapsible tree view, dispatched by the file's extension.
export default function JsonTreeView({ value, fileName }: Props) {
  const { t } = useI18n();
  const base = fileName?.split('/').pop() ?? '';
  const { parsed, error } = parseByExtension(base, value);
  if (parsed === undefined) {
    return (
      <div className="jtree-fallback">
        {error && <p className="jtree-parse-error">{t('jtree.parseError', { format: error.toUpperCase() })}</p>}
        <pre className="home-config-file-editor" spellCheck={false}>{value}</pre>
      </div>
    );
  }

  return (
    <div className="jtree">
      <JsonNode value={parsed} depth={0} />
    </div>
  );
}