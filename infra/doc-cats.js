'use strict';
/**
 * infra/doc-cats.js — the document categories a fresh installation starts with.
 *
 * These are only DEFAULTS. The live list lives in `app_settings.doc_cats`, is
 * administrator-editable, and is self-healing: repo.getDocCategories() adds any
 * category that has documents filed under it but is missing from the configured
 * list, so no upload can ever be hidden by a category that was deleted.
 *
 * ── Why it is shared rather than written twice ──
 * The server seeds from this list; the browser falls back to it when the
 * bootstrap response carried no settings at all. Two copies existed, and while
 * they happened to agree, nothing made them: renaming "Residence certificate"
 * on one side would have produced two names for one category key, which reads
 * as two categories to anybody comparing a screen against an export.
 *
 * Same dual-mode loading as infra/age.js — a plain script in the browser
 * (`window.KDDocCats`), a require() in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KDDocCats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DEFAULT_DOC_CATS = [
    { key: 'passport',  label: 'Passport' },
    { key: 'id_card',   label: 'ID Card' },
    { key: 'residence', label: 'Residence certificate' },
    { key: 'form_1',    label: 'Form 1' },
    { key: 'form_2',    label: 'Form 2' },
    { key: 'land_doc',  label: 'Land document' },
  ];

  /** A fresh copy, so a caller cannot mutate the defaults for everyone else. */
  function defaults() {
    return DEFAULT_DOC_CATS.map(c => ({ key: c.key, label: c.label }));
  }

  return { DEFAULT_DOC_CATS, defaults };
});
