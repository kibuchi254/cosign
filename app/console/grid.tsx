'use client';

// AG Grid with the Cosign theme, shared by the payments and audit screens: search, CSV export,
// row click, and a slot for filter tabs.

import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  DateFilterModule,
  NumberFilterModule,
  QuickFilterModule,
  RowSelectionModule,
  RowStyleModule,
  TextFilterModule,
  TooltipModule,
  themeQuartz,
  type ColDef,
  type GridApi,
  type RowClickedEvent,
} from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { Download, Search } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

const modules = [CellStyleModule, ClientSideRowModelModule, TextFilterModule, NumberFilterModule, DateFilterModule, QuickFilterModule, ColumnAutoSizeModule, RowSelectionModule, RowStyleModule, CsvExportModule, TooltipModule];

export const cosignGridTheme = themeQuartz.withParams({
  fontFamily: 'var(--cs-font)',
  fontSize: 14,
  accentColor: 'var(--cs-sign)',
  foregroundColor: 'var(--cs-ink)',
  backgroundColor: 'var(--cs-paper)',
  borderColor: 'var(--cs-paper-edge)',
  headerBackgroundColor: 'var(--cs-panel)',
  headerTextColor: 'var(--cs-ink-soft)',
  headerFontWeight: 600,
  headerFontSize: 13,
  rowHoverColor: 'var(--cs-hover)',
  selectedRowBackgroundColor: 'var(--cs-sign-wash)',
  wrapperBorderRadius: 12,
  rowHeight: 56,
  headerHeight: 44,
  rowBorder: { color: 'var(--cs-rule)' },
  columnBorder: false,
  cellHorizontalPadding: 16,
});

export function Grid<T extends object>({
  rows,
  columns,
  onRowClicked,
  searchLabel = 'Search',
  height = 'calc(100dvh - 19rem)',
  toolbar,
  exportName,
  getRowId,
}: {
  rows: T[];
  columns: ColDef<T>[];
  onRowClicked?: (row: T) => void;
  searchLabel?: string;
  height?: string;
  toolbar?: ReactNode;
  exportName?: string;
  getRowId?: (row: T) => string;
}) {
  const [search, setSearch] = useState('');
  const api = useRef<GridApi<T> | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <label className="relative ml-auto w-full sm:w-56 2xl:w-72">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-cs-faint" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="h-10 w-full rounded-lg border border-cs-edge bg-cs-paper pr-3 pl-9 text-sm focus:border-cs-sign focus:ring-2 focus:ring-cs-sign/20 focus:outline-none"
          />
        </label>
        {exportName && (
          <button
            type="button"
            onClick={() => api.current?.exportDataAsCsv({ fileName: `${exportName}-${new Date().toISOString().slice(0, 10)}.csv` })}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-cs-edge bg-cs-paper px-3 text-sm font-semibold hover:bg-cs-hover"
          >
            <Download aria-hidden className="size-4" /> Export CSV
          </button>
        )}
      </div>
      <div style={{ height, minHeight: 360 }}>
        <AgGridProvider modules={modules}>
          <AgGridReact<T>
            theme={cosignGridTheme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={{
              filter: true,
              sortable: true,
              resizable: true,
              cellClass: 'cs-cell',
              // Truncated text stays readable: the browser tooltip shows the whole value.
              tooltipValueGetter: (p) => (p.valueFormatted ?? (typeof p.value === 'object' ? undefined : p.value)) as string | undefined,
            }}
            enableBrowserTooltips
            quickFilterText={search}
            // Flex columns share the spare width; fixed ones keep the width they were given.
            autoSizeStrategy={columns.some((c) => c.flex) ? undefined : { type: 'fitGridWidth', defaultMinWidth: 110 }}
            rowSelection={onRowClicked ? { mode: 'singleRow', checkboxes: false, enableClickSelection: true } : undefined}
            onRowClicked={onRowClicked ? (e: RowClickedEvent<T>) => e.data && onRowClicked(e.data) : undefined}
            onGridReady={(e) => {
              api.current = e.api;
            }}
            getRowId={getRowId ? (p) => getRowId(p.data) : undefined}
            rowClass={onRowClicked ? 'cursor-pointer' : undefined}
            overlayNoRowsTemplate="<span style='color:var(--cs-ink-soft)'>Nothing matches. Try another filter or search.</span>"
            enableCellTextSelection
          />
        </AgGridProvider>
      </div>
    </div>
  );
}
