// Generic master-data page (FR-14): list + create/edit form modal + deactivate/delete confirmation.
// Master-data pages only describe their columns, form fields and payload mapping; this component
// handles loading, validation, saving, toasts and role-based visibility of the controls.
import { useMemo, useState } from 'react';
import DataTable from './DataTable.jsx';
import Icon from './Icon.jsx';
import { ConfirmDialog, Modal } from './Modal.jsx';
import { FormGrid, validateFields } from './FormFields.jsx';
import { Banner, Card, ErrorBanner, LastUpdated, PageHeader, Spinner } from './ui.jsx';
import { api, ApiError, errorMessage } from '../api/client.js';
import { useResource } from '../hooks/useResource.js';
import { useToast } from '../context/ToastContext.jsx';

/** Maps `error.details` from a VALIDATION_ERROR (object or array form) onto form field errors. */
function serverFieldErrors(err) {
  if (!(err instanceof ApiError) || !err.details) return {};
  const d = err.details;
  if (Array.isArray(d)) {
    return Object.fromEntries(d.filter((x) => x && (x.field || x.path)).map((x) => [x.field || x.path, x.message]));
  }
  if (typeof d === 'object') {
    return Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === 'string'));
  }
  return {};
}

export default function CrudPage({
  title,
  subtitle,
  itemName = 'record',
  endpoint,
  query,
  columns,
  fields,                 // array, or (values, mode, row) => array
  emptyValues = {},       // object, or () => object
  toForm = (row) => ({ ...row }),
  toPayload = (values) => values,
  validate,               // (values, mode, row) => { field: message }
  customSubmit,           // optional ({ mode, values, payload, row }) => Promise<string|void>
  canCreate = false,
  canEdit = () => false,
  canRemove = () => false,
  removeLabel = 'Deactivate',
  removeTone = 'danger',
  removeMessage,
  isActive,               // (row) => boolean; enables the "show inactive" toggle (soft delete)
  rowName = (row) => row.name || row.fullName || `#${row.id}`,
  readOnlyNote,
  toolbar,
  headerActions,
  initialSort,
  extraRowActions,
  onChanged,
  transformRows,
  emptyText,
  formNote,
  modalSize = 'md',
  summary,               // optional (rows) => node rendered above the table
  children,
}) {
  const toast = useToast();
  const list = useResource(endpoint, query);
  const [showInactive, setShowInactive] = useState(true);
  const [form, setForm] = useState(null);         // { mode: 'create'|'edit', row, values }
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);  // row being removed
  const [removeBusy, setRemoveBusy] = useState(false);

  const allRows = useMemo(() => {
    const rows = Array.isArray(list.data) ? list.data : [];
    return transformRows ? transformRows(rows) : rows;
  }, [list.data, transformRows]);

  const rows = useMemo(
    () => (isActive && !showInactive ? allRows.filter((r) => isActive(r)) : allRows),
    [allRows, isActive, showInactive],
  );
  const inactiveCount = isActive ? allRows.filter((r) => !isActive(r)).length : 0;

  const resolveFields = (values, mode, row) => (typeof fields === 'function' ? fields(values, mode, row) : fields);
  const currentFields = form ? resolveFields(form.values, form.mode, form.row) : [];

  const openCreate = () => {
    const base = typeof emptyValues === 'function' ? emptyValues() : emptyValues;
    setErrors({});
    setFormError(null);
    setForm({ mode: 'create', row: null, values: { ...base } });
  };

  const openEdit = (row) => {
    setErrors({});
    setFormError(null);
    setForm({ mode: 'edit', row, values: toForm(row) });
  };

  const closeForm = () => { if (!saving) setForm(null); };

  const setValue = (name, value) => {
    setForm((f) => ({ ...f, values: { ...f.values, [name]: value } }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (!form) return;
    const { mode, row, values } = form;
    const visibleFields = resolveFields(values, mode, row).filter((f) => !f.hidden);
    // Page-specific checks add to the generic ones; an `undefined` entry from a page validator
    // means "no extra problem" and must not hide a generic error such as "is required".
    const errs = validateFields(visibleFields, values);
    const extra = validate ? validate(values, mode, row) : {};
    Object.entries(extra || {}).forEach(([k, msg]) => { if (msg) errs[k] = msg; });
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Please correct the highlighted fields.');
      return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const payload = toPayload(values, mode, row);
      let message;
      if (customSubmit) {
        message = await customSubmit({ mode, values, payload, row });
      } else if (mode === 'create') {
        await api.post(endpoint, payload);
      } else {
        await api.put(`${endpoint}/${row.id}`, payload);
      }
      toast.success(message || (mode === 'create' ? `New ${itemName} created` : `${capitalise(itemName)} updated`));
      setForm(null);
      await list.reload({ silent: true });
      onChanged?.();
    } catch (err) {
      const fieldErrs = serverFieldErrors(err);
      setErrors((prev) => ({ ...prev, ...fieldErrs }));
      setFormError(errorMessage(err));
      // A multi-step submit may have partly succeeded; keep the list in sync.
      list.reload({ silent: true });
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await api.del(`${endpoint}/${removing.id}`);
      toast.success(`${capitalise(itemName)} "${rowName(removing)}" ${removeLabel === 'Deactivate' ? 'deactivated' : 'removed'}`);
      setRemoving(null);
      await list.reload({ silent: true });
      onChanged?.();
    } catch (err) {
      toast.error(err);
    } finally {
      setRemoveBusy(false);
    }
  };

  const hasActions = (row) => canEdit(row) || (canRemove(row) && (!isActive || isActive(row))) || extraRowActions;
  const showActionsColumn = allRows.some((r) => hasActions(r)) || Boolean(extraRowActions);

  const tableToolbar = (
    <>
      {toolbar}
      {isActive && inactiveCount > 0 && (
        <label className="check check-inline">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          <span>Show inactive ({inactiveCount})</span>
        </label>
      )}
    </>
  );

  return (
    <div className="page">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={(
          <>
            <LastUpdated at={list.updatedAt} refreshing={list.refreshing} />
            {headerActions}
            <button type="button" className="btn btn-secondary" onClick={() => list.reload({ silent: true })} title="Refresh">
              <Icon name="refresh" size={16} />
            </button>
            {canCreate && (
              <button type="button" className="btn btn-primary" onClick={openCreate}>
                <Icon name="plus" size={16} /> Add {itemName}
              </button>
            )}
          </>
        )}
      />

      {readOnlyNote && <Banner kind="info">{readOnlyNote}</Banner>}
      <ErrorBanner error={list.error} onRetry={() => list.reload()} />

      {children}
      {summary && !list.loading && summary(allRows)}

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          loading={list.loading}
          toolbar={tableToolbar}
          initialSort={initialSort}
          emptyTitle={`No ${itemName}s yet`}
          emptyText={emptyText}
          rowClassName={(r) => (isActive && !isActive(r) ? 'row-inactive' : undefined)}
          actions={showActionsColumn ? (row) => (
            <>
              {extraRowActions?.(row)}
              {canEdit(row) && (
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => openEdit(row)}>
                  <Icon name="edit" size={14} /> Edit
                </button>
              )}
              {canRemove(row) && (!isActive || isActive(row)) && (
                <button type="button" className={`btn btn-sm btn-${removeTone}-ghost`} onClick={() => setRemoving(row)}>
                  <Icon name={removeLabel === 'Deactivate' ? 'power' : 'trash'} size={14} /> {removeLabel}
                </button>
              )}
            </>
          ) : undefined}
        />
      </Card>

      <Modal
        open={Boolean(form)}
        title={form?.mode === 'create' ? `Add ${itemName}` : `Edit ${itemName}${form?.row ? ` — ${rowName(form.row)}` : ''}`}
        onClose={closeForm}
        busy={saving}
        size={modalSize}
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={closeForm} disabled={saving}>Cancel</button>
            <button type="submit" form="crud-form" className="btn btn-primary" disabled={saving}>
              {saving && <Spinner size="xs" />} {form?.mode === 'create' ? 'Create' : 'Save changes'}
            </button>
          </>
        )}
      >
        {form && (
          <form id="crud-form" onSubmit={submit} noValidate>
            {formError && <Banner kind="error">{formError}</Banner>}
            {formNote && formNote(form.mode, form.values, form.row)}
            <FormGrid fields={currentFields} values={form.values} errors={errors} onChange={setValue} />
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(removing)}
        title={`${removeLabel} ${itemName}`}
        confirmLabel={removeLabel}
        tone={removeTone}
        busy={removeBusy}
        onCancel={() => !removeBusy && setRemoving(null)}
        onConfirm={confirmRemove}
        message={removing && (removeMessage ? removeMessage(removing) : (
          removeLabel === 'Deactivate'
            ? <>Deactivate <strong>{rowName(removing)}</strong>? The record is kept for history and can be re-activated by editing it.</>
            : <>Permanently remove <strong>{rowName(removing)}</strong>?</>
        ))}
      />
    </div>
  );
}

function capitalise(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
