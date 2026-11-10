// Generic table with client-side search, column sorting and paging.
// Column: { key, label, render?(row), sortValue?(row), searchValue?(row), align?, sortable?, className? }
// Loading shows skeleton rows and an empty result shows the empty state inside the table, so the
// header (and the column layout) stays in place.
import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { EmptyState, Skeleton } from './ui.jsx';

function defaultValue(row, col) {
  if (col.sortValue) return col.sortValue(row);
  return row?.[col.key];
}

const isBlank = (v) => v === null || v === undefined || v === '';
const SKELETON_WIDTHS = [80, 60, 40, 100, 60];

/** Compares two present (non-blank) values; blanks are handled by the caller. */
function compare(a, b) {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(b) - Number(a);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

const alignClass = (c) => (c.align ? `align-${c.align}` : '');

export default function DataTable({
  columns,
  rows,
  rowKey = 'id',
  loading = false,
  searchable = true,
  searchPlaceholder = 'Search…',
  emptyTitle = 'No records',
  emptyText,
  actions,
  rowClassName,
  initialSort,
  pageSize = 25,
  toolbar,
  dense = false,
  caption,
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(initialSort || null); // { key, dir: 'asc'|'desc' }
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const list = Array.isArray(rows) ? rows : [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => columns.some((c) => {
      const v = c.searchValue ? c.searchValue(r) : r?.[c.key];
      return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
    }));
  }, [rows, columns, query]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === 'desc' ? -1 : 1;
    // Empty values ("—") always go last, whichever direction is chosen.
    return [...filtered].sort((a, b) => {
      const va = defaultValue(a, col);
      const vb = defaultValue(b, col);
      if (isBlank(va) || isBlank(vb)) return Number(isBlank(va)) - Number(isBlank(vb));
      return dir * compare(va, vb);
    });
  }, [filtered, sort, columns]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => { if (page > pages - 1) setPage(0); }, [page, pages]);
  const visible = pageSize ? sorted.slice(page * pageSize, page * pageSize + pageSize) : sorted;

  const toggleSort = (col) => {
    if (col.sortable === false) return;
    setSort((s) => {
      if (!s || s.key !== col.key) return { key: col.key, dir: 'asc' };
      if (s.dir === 'asc') return { key: col.key, dir: 'desc' };
      return null;
    });
  };

  const hasRows = Array.isArray(rows) && rows.length > 0;
  const showSkeleton = loading && !hasRows;
  const colSpan = columns.length + (actions ? 1 : 0);

  let body;
  if (showSkeleton) {
    body = Array.from({ length: 5 }, (_, i) => (
      <tr key={`sk-${i}`} className="row-skeleton" aria-hidden="true">
        {columns.map((c, j) => (
          <td key={c.key} className={alignClass(c)}><Skeleton w={SKELETON_WIDTHS[(i + j) % 5]} /></td>
        ))}
        {actions && <td className="align-right col-actions"><Skeleton w={60} /></td>}
      </tr>
    ));
  } else if (sorted.length === 0) {
    body = (
      <tr className="row-empty">
        <td colSpan={colSpan}>
          <EmptyState icon={query ? 'search' : 'inbox'} title={query ? 'No matching records' : emptyTitle}>
            {query ? `Nothing matches "${query}".` : emptyText}
          </EmptyState>
        </td>
      </tr>
    );
  } else {
    body = visible.map((row, i) => (
      <tr
        key={typeof rowKey === 'function' ? rowKey(row, i) : (row?.[rowKey] ?? i)}
        className={rowClassName ? rowClassName(row) : undefined}
      >
        {columns.map((c) => (
          <td key={c.key} className={`${alignClass(c)} ${c.className || ''}`} data-label={c.label}>
            {c.render ? c.render(row) : (row?.[c.key] ?? '—')}
          </td>
        ))}
        {actions && <td className="align-right col-actions" data-label="Actions"><div className="row-actions">{actions(row)}</div></td>}
      </tr>
    ));
  }

  return (
    <div className="table-wrap">
      {(searchable || toolbar) && (
        <div className="table-toolbar">
          {searchable && (
            <label className="search-box">
              <Icon name="search" size={16} />
              <input
                type="search"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                placeholder={searchPlaceholder}
                aria-label="Search table"
              />
            </label>
          )}
          {toolbar && <div className="table-toolbar-extra">{toolbar}</div>}
        </div>
      )}

      <div className="table-scroll">
        <table className={`table ${dense ? 'table-dense' : ''}`} aria-busy={showSkeleton ? 'true' : undefined}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                const sortable = c.sortable !== false;
                return (
                  <th
                    key={c.key}
                    className={`${alignClass(c)} ${sortable ? 'sortable' : ''}`}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    scope="col"
                  >
                    {sortable ? (
                      <button type="button" className={`th-btn ${active ? 'on' : ''}`} onClick={() => toggleSort(c)}>
                        {c.label}
                        <Icon
                          name={active && sort.dir === 'asc' ? 'chevronUp' : 'chevronDown'}
                          size={12}
                          className={`sort-ind ${active ? 'on' : ''}`}
                        />
                      </button>
                    ) : c.label}
                  </th>
                );
              })}
              {actions && <th className="align-right col-actions" scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {showSkeleton && <span className="sr-only" role="status">Loading…</span>}

      {pageSize && sorted.length > pageSize && (
        <div className="pager">
          <span className="pager-info">
            {page * pageSize + 1}–{Math.min(sorted.length, (page + 1) * pageSize)} of {sorted.length}
          </span>
          <div className="pager-btns">
            <button type="button" className="btn btn-sm btn-secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <Icon name="chevronLeft" size={14} /> Previous
            </button>
            <button type="button" className="btn btn-sm btn-secondary" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
              Next <Icon name="chevronRight" size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
