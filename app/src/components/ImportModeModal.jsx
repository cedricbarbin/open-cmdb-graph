import React from 'react';
import Modal from './Modal.jsx';

/** Asks how to handle rows in a CSV/ZIP import whose `id` already matches
 * an existing node, before the import actually runs. Shared by
 * EntityListScreen's single-type "Import CSV" and BackupRestorePage's
 * "Restore ZIP" - both need the exact same choice. Rows whose `id` is new
 * are always created either way; this only changes what happens to rows
 * that collide with an existing node. */
export default function ImportModeModal({ onChoose, onClose }) {
  return (
    <Modal title="Existing nodes" onClose={onClose}>
      <p>
        If a row's <code>id</code> already matches a node in the database, should it
        replace that node's properties, or be left alone?
      </p>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" onClick={() => onChoose('ignore')}>Ignore existing</button>
        <button type="button" onClick={() => onChoose('replace')}>Replace existing</button>
      </div>
    </Modal>
  );
}
