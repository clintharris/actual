/**
 * Reproduction for: CSV import silently drops transactions when an existing
 * transaction in the same account has the same amount within ±7 days.
 *
 * This test simulates the exact flow of the CSV import dialog
 * (ImportTransactionsModal):
 *   1. preview call  -> reconcileTransactions(..., isPreview = true)
 *   2. default toggle state assignment (onImportPreview onSuccess handler)
 *   3. final import  -> reconcileTransactions(..., isPreview = false),
 *      with forceAddTransaction set per the modal's onImport rules.
 */
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { loadRules } from '#server/transactions/transaction-rules';

import { reconcileTransactions } from './sync';
import type { ReconcileTransactionsResult } from './sync';

const emptyDatabase = (
  global as unknown as {
    emptyDatabase: () => () => Promise<void>;
  }
).emptyDatabase;

beforeEach(async () => {
  await emptyDatabase()();
  await loadMappings();
  await loadRules();
});

type UiRow = {
  trx_id: string;
  date: string;
  amount: number;
  payee_name: string;
  // UI state managed by the modal:
  existing?: boolean;
  ignored?: boolean;
  selected?: boolean;
  selected_merge?: boolean;
};

async function setupAccountWithExistingTransaction() {
  const acctId = await db.insertAccount({ id: 'chase', name: 'Chase Bank' });
  await db.insertPayee({
    id: 'transfer-' + acctId,
    name: '',
    transfer_acct: acctId,
  });

  const netflixPayeeId = await db.insertPayee({ name: 'Netflix' });
  // A manually-entered transaction already in the register: $8.99 on May 10
  await db.insertTransaction({
    id: 'existing-netflix',
    account: acctId,
    amount: -899,
    date: '2024-05-10',
    payee: netflixPayeeId,
    cleared: 1,
  });

  return acctId;
}

function getAllTransactions() {
  return db.all<db.DbViewTransactionInternal>(
    `SELECT * FROM v_transactions_internal ORDER BY date DESC, id`,
  );
}

/**
 * Mirrors ImportTransactionsModal.onImportPreview onSuccess: assigns the
 * default toggle state to each parsed CSV row based on the preview result.
 */
function applyPreviewDefaults(
  rows: UiRow[],
  updatedPreview: ReconcileTransactionsResult['updatedPreview'],
): UiRow[] {
  const matchedUpdateMap = new Map(
    // trx_id is an extra field the modal attaches to each parsed row; it
    // survives normalization but isn't part of TransactionEntity (the modal
    // reads it the same way, via a ts-expect-error).
    updatedPreview.map(entry => [
      (entry.transaction as { trx_id?: string }).trx_id,
      entry,
    ]),
  );

  return rows.map(row => {
    const entry = matchedUpdateMap.get(row.trx_id);
    const existing = !!entry?.existing;
    const ignored = entry?.ignored || false;
    return {
      ...row,
      existing,
      ignored,
      selected: !ignored,
      selected_merge: existing,
    };
  });
}

/**
 * Mirrors ImportTransactionsModal.onImport: filters rows and sets
 * forceAddTransaction according to the toggle state, producing the payload
 * sent to the non-preview 'transactions-import' call. reconcile = true.
 */
function buildImportPayload(rows: UiRow[]) {
  const finalTransactions = [];
  for (const row of rows) {
    if (!row.selected && !row.ignored) {
      // unselected transactions that are not ignored are skipped
      continue;
    }

    const {
      existing: _existing,
      ignored: _ignored,
      selected: _selected,
      selected_merge: _selected_merge,
      trx_id: _trx_id,
      ...finalTransaction
    } = row;

    if (
      (row.ignored && row.selected) ||
      (row.existing && row.selected && !row.selected_merge)
    ) {
      finalTransactions.push({
        ...finalTransaction,
        forceAddTransaction: true,
      });
    } else {
      finalTransactions.push(finalTransaction);
    }
  }
  return finalTransactions;
}

describe('CSV import silent transaction drop', () => {
  test('REPRO 1: new transaction with same amount as an existing one is merged, not added (default toggle state)', async () => {
    const acctId = await setupAccountWithExistingTransaction();

    // The CSV contains a *different, genuinely new* purchase that happens to
    // have the same amount ($8.99) two days later.
    const csvRows: UiRow[] = [
      {
        trx_id: 'row-1',
        date: '2024-05-12',
        payee_name: 'Corner Coffee',
        amount: -899,
      },
    ];

    // Step 1: the modal's preview call
    const preview = await reconcileTransactions(
      acctId,
      csvRows,
      false, // isBankSyncAccount
      true, // strictIdChecking
      true, // isPreview
    );

    // The CSV row fuzzy-matched the existing Netflix transaction purely on
    // amount + date proximity...
    expect(preview.updatedPreview).toHaveLength(1);
    // ...and it is NOT flagged as "ignored" — the dialog shows it checked, in
    // the default "merge with existing" state. Nothing warns the user.
    expect(preview.updatedPreview[0].ignored).not.toBe(true);
    expect(preview.updatedPreview[0].existing).toBeTruthy();

    // Step 2 + 3: default toggle state, then the real import
    const uiRows = applyPreviewDefaults(csvRows, preview.updatedPreview);
    expect(uiRows[0]).toMatchObject({
      selected: true, // checked — user sees it as "will be imported"
      ignored: false, // user verified it is not marked ignore
      selected_merge: true, // ...but the default action is MERGE
    });

    const result = await reconcileTransactions(
      acctId,
      buildImportPayload(uiRows),
      false,
      true,
      false, // real import
    );

    // BUG (from the user's perspective): nothing was added. The Corner Coffee
    // purchase was merged into the existing Netflix transaction and is gone.
    expect(result.added).toHaveLength(0);

    const transactions = await getAllTransactions();
    expect(transactions).toHaveLength(1);
    // The existing transaction absorbed the CSV row's imported_payee:
    expect(transactions[0].imported_payee).toBe('Corner Coffee');
  });

  test('REPRO 2: preview shows row as brand-new (no merge/ignore flag), yet import still drops it', async () => {
    const acctId = await setupAccountWithExistingTransaction();

    // CSV contains a true duplicate of the existing Netflix transaction AND a
    // genuinely new same-amount purchase.
    const csvRows: UiRow[] = [
      {
        trx_id: 'row-dup',
        date: '2024-05-10',
        payee_name: 'Netflix',
        amount: -899,
      },
      {
        trx_id: 'row-new',
        date: '2024-05-12',
        payee_name: 'Corner Coffee',
        amount: -899,
      },
    ];

    const preview = await reconcileTransactions(
      acctId,
      csvRows,
      false,
      true,
      true,
    );

    // In the preview, the duplicate row claims the match with the existing
    // transaction. The new row matches nothing: the dialog shows it as a
    // plain new transaction — checked, no merge indicator, no ignore flag.
    const previewIds = preview.updatedPreview.map(
      e => (e.transaction as { trx_id?: string }).trx_id,
    );
    expect(previewIds).toContain('row-dup');
    expect(previewIds).not.toContain('row-new');

    let uiRows = applyPreviewDefaults(csvRows, preview.updatedPreview);

    // The user recognizes row-dup as a duplicate and unchecks it (clicking
    // the 3-state toggle until fully unselected). row-new stays checked.
    uiRows = uiRows.map(row =>
      row.trx_id === 'row-dup'
        ? { ...row, selected: false, selected_merge: false }
        : row,
    );

    const payload = buildImportPayload(uiRows);
    // Only the genuinely new row is sent to the import:
    expect(payload.map(t => t.payee_name)).toEqual(['Corner Coffee']);

    const result = await reconcileTransactions(
      acctId,
      payload,
      false,
      true,
      false,
    );

    // BUG: matching reruns from scratch on import. With the duplicate row no
    // longer present to claim the existing transaction, the "new" row now
    // fuzzy-matches it and is merged — silently dropped, even though the
    // preview showed it as a new transaction with no warning at all.
    expect(result.added).toHaveLength(0);
    expect(await getAllTransactions()).toHaveLength(1);
  });

  test('CONTROL: same amount but outside the ±7 day window imports fine', async () => {
    const acctId = await setupAccountWithExistingTransaction();

    const csvRows: UiRow[] = [
      {
        trx_id: 'row-1',
        date: '2024-05-20', // 10 days after the existing transaction
        payee_name: 'Corner Coffee',
        amount: -899,
      },
    ];

    const preview = await reconcileTransactions(
      acctId,
      csvRows,
      false,
      true,
      true,
    );
    expect(preview.updatedPreview).toHaveLength(0); // no match in preview

    const uiRows = applyPreviewDefaults(csvRows, preview.updatedPreview);
    const result = await reconcileTransactions(
      acctId,
      buildImportPayload(uiRows),
      false,
      true,
      false,
    );

    expect(result.added).toHaveLength(1);
    expect(await getAllTransactions()).toHaveLength(2);
  });

  test('WORKAROUND: toggling the matched row to "add as new" (one extra click) forces the add', async () => {
    const acctId = await setupAccountWithExistingTransaction();

    const csvRows: UiRow[] = [
      {
        trx_id: 'row-1',
        date: '2024-05-12',
        payee_name: 'Corner Coffee',
        amount: -899,
      },
    ];

    const preview = await reconcileTransactions(
      acctId,
      csvRows,
      false,
      true,
      true,
    );
    let uiRows = applyPreviewDefaults(csvRows, preview.updatedPreview);

    // One click on the 3-state toggle: (selected + merge) -> (selected, no
    // merge) = "add as new transaction"
    uiRows = uiRows.map(row => ({ ...row, selected_merge: false }));

    const result = await reconcileTransactions(
      acctId,
      buildImportPayload(uiRows),
      false,
      true,
      false,
    );

    expect(result.added).toHaveLength(1);
    expect(await getAllTransactions()).toHaveLength(2);
  });
});
