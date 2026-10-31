// Schema-driven form fields used by the generic CRUD form modal.
// Field: { name, label, type, required?, options?: [{value,label}], placeholder?, help?, min?, max?, step?,
//          disabled?, full?: boolean (span both columns), autoComplete?, suggestions?: string[] }
// Types: text | email | password | tel | number | select | checkbox | time | date | textarea | suggest | days
import { useId } from 'react';
import { DAYS_OF_WEEK } from '../utils/format.js';

export function isEmptyValue(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

/** Built-in checks shared by every form: required fields and numeric ranges. */
export function validateFields(fields, values) {
  const errors = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.type === 'checkbox') continue;
    if (f.required && isEmptyValue(v)) {
      errors[f.name] = f.type === 'days' ? 'Select at least one day' : `${f.label} is required`;
      continue;
    }
    if (isEmptyValue(v)) continue;
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[f.name] = 'Enter a number';
      else if (f.min !== undefined && n < f.min) errors[f.name] = `Must be at least ${f.min}`;
      else if (f.max !== undefined && n > f.max) errors[f.name] = `Must be at most ${f.max}`;
      else if (f.integer && !Number.isInteger(n)) errors[f.name] = 'Enter a whole number';
    }
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim())) {
      errors[f.name] = 'Enter a valid e-mail address';
    }
    if (f.type === 'password' && f.minLength && String(v).length < f.minLength) {
      errors[f.name] = `At least ${f.minLength} characters`;
    }
    if (f.type === 'time' && !/^\d{2}:\d{2}$/.test(String(v))) {
      errors[f.name] = 'Use HH:mm';
    }
  }
  return errors;
}

function Control({ field, value, onChange, id, error }) {
  const common = {
    id,
    name: field.name,
    disabled: field.disabled,
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': error ? `${id}-err` : field.help ? `${id}-help` : undefined,
  };

  switch (field.type) {
    case 'select':
      return (
        <select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)} required={field.required}>
          {field.placeholder !== false && <option value="">{field.placeholder || 'Select…'}</option>}
          {(field.options || []).map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
          ))}
        </select>
      );
    case 'checkbox':
      return (
        <label className="check">
          <input {...common} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span>{field.checkboxLabel || field.label}</span>
        </label>
      );
    case 'textarea':
      return (
        <textarea {...common} rows={field.rows || 3} value={value ?? ''} placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)} />
      );
    case 'days': {
      const selected = Array.isArray(value) ? value.map(Number) : [];
      const toggle = (d) => onChange(selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d].sort((a, b) => a - b));
      return (
        <div className="day-picker" role="group" aria-labelledby={`${id}-label`}>
          {DAYS_OF_WEEK.map((d) => (
            <label key={d.value} className={`day-chip ${selected.includes(d.value) ? 'on' : ''}`} title={d.label}>
              <input type="checkbox" checked={selected.includes(d.value)} onChange={() => toggle(d.value)} disabled={field.disabled} />
              {d.short}
            </label>
          ))}
          <button type="button" className="link-btn" onClick={() => onChange(DAYS_OF_WEEK.map((d) => d.value))}>All</button>
          <button type="button" className="link-btn" onClick={() => onChange([1, 2, 3, 4, 5])}>Mon–Fri</button>
        </div>
      );
    }
    case 'suggest': {
      const listId = `${id}-list`;
      return (
        <>
          <input {...common} type="text" list={listId} value={value ?? ''} placeholder={field.placeholder}
            autoComplete="off" onChange={(e) => onChange(e.target.value)} />
          <datalist id={listId}>
            {(field.suggestions || []).map((s) => <option key={s} value={s} />)}
          </datalist>
        </>
      );
    }
    default:
      return (
        <input
          {...common}
          type={field.type || 'text'}
          value={value ?? ''}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          step={field.step}
          autoComplete={field.autoComplete || (field.type === 'password' ? 'new-password' : 'off')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export function FormField({ field, value, onChange, error }) {
  const id = useId();
  const isCheckbox = field.type === 'checkbox';
  return (
    <div className={`field ${field.full ? 'field-full' : ''} ${error ? 'has-error' : ''}`}>
      {!isCheckbox && (
        <label htmlFor={id} id={`${id}-label`} className="field-label">
          {field.label}{field.required && <span className="req" aria-hidden="true"> *</span>}
        </label>
      )}
      <Control field={field} value={value} onChange={onChange} id={id} error={error} />
      {error ? (
        <span className="field-error" id={`${id}-err`}>{error}</span>
      ) : field.help ? (
        <span className="field-help" id={`${id}-help`}>{field.help}</span>
      ) : null}
    </div>
  );
}

export function FormGrid({ fields, values, errors = {}, onChange }) {
  return (
    <div className="form-grid">
      {fields.filter((f) => !f.hidden).map((f) => (
        <FormField
          key={f.name}
          field={f}
          value={values[f.name]}
          error={errors[f.name]}
          onChange={(v) => onChange(f.name, v)}
        />
      ))}
    </div>
  );
}
