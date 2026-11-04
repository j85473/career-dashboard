'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import type { PDFViewer } from 'pdfjs-dist/types/web/pdf_viewer';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist/types/src/display/api';

const zoomLevels = [25, 50, 75, 100, 125, 150, 200, 300];

/** Own the surround color rather than delegating it to each browser's PDF plugin. */
export function PdfDocumentViewer({ url, label }: { url: string; label: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | undefined;
    let resize: ResizeObserver | undefined;
    const controller = new AbortController();
    const load = async () => {
      // The viewer reads the library's global exports, so initialize these in order.
      const pdf = await import('pdfjs-dist');
      pdf.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      const { PDFViewer, EventBus, PDFLinkService, LinkTarget } = await import('pdfjs-dist/web/pdf_viewer.mjs');
      if (cancelled || !containerRef.current || !pagesRef.current) return;
      const eventBus = new EventBus();
      const links = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer' });
      const options = { container: containerRef.current, viewer: pagesRef.current, eventBus, linkService: links,
        removePageBorders: true, annotationMode: pdf.AnnotationMode.ENABLE, maxCanvasPixels: 16_777_216,
        abortSignal: controller.signal };
      const viewer = new PDFViewer(options);
      viewerRef.current = viewer;
      links.setViewer(viewer);
      eventBus.on('pagesinit', () => {
        if (cancelled) return;
        viewer.currentScaleValue = 'page-width';
        setPageCount(viewer.pagesCount);
      });
      eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => { if (!cancelled) setPage(pageNumber); });
      eventBus.on('scalechanging', ({ scale }: { scale: number }) => { if (!cancelled) setZoom(Math.round(scale * 100)); });
      loading = pdf.getDocument({ url, useSystemFonts: true });
      const document = await loading.promise;
      if (cancelled) return;
      links.setDocument(document);
      viewer.setDocument(document);
      resize = new ResizeObserver(() => {
        if (!cancelled && ['page-width', 'page-fit'].includes(viewer.currentScaleValue)) {
          viewer.currentScaleValue = viewer.currentScaleValue;
        }
      });
      resize.observe(containerRef.current);
    };
    void load().catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      resize?.disconnect();
      controller.abort();
      viewerRef.current?.setDocument(null);
      viewerRef.current = null;
      void loading?.destroy().catch(() => {});
    };
  }, [url, attempt]);

  const changeZoom = (factor: number) => {
    const viewer = viewerRef.current;
    if (viewer && pageCount) viewer.currentScale = Math.max(.25, Math.min(3, viewer.currentScale * factor));
  };

  return <div className="pdf-document-viewer">
    <div className="pdf-preview-toolbar" role="toolbar" aria-label="PDF controls">
      <button type="button" aria-label="Previous PDF page" disabled={!pageCount || page <= 1}
        onClick={() => { if (viewerRef.current) viewerRef.current.currentPageNumber = page - 1; }}><ChevronLeft size={17} /></button>
      <span className="pdf-preview-page-count">{pageCount ? `${page} / ${pageCount}` : '—'}</span>
      <button type="button" aria-label="Next PDF page" disabled={!pageCount || page >= pageCount}
        onClick={() => { if (viewerRef.current) viewerRef.current.currentPageNumber = page + 1; }}><ChevronRight size={17} /></button>
      <span className="pdf-preview-toolbar-divider" />
      <button type="button" aria-label="Zoom out PDF" disabled={!pageCount || zoom <= 25} onClick={() => changeZoom(.8)}><Minus size={17} /></button>
      <select aria-label="PDF zoom" value={zoom} disabled={!pageCount} onChange={event => {
        if (viewerRef.current) viewerRef.current.currentScale = Number(event.target.value) / 100;
      }}>
        {!zoomLevels.includes(zoom) && <option value={zoom}>{zoom}%</option>}
        {zoomLevels.map(value => <option key={value} value={value}>{value}%</option>)}
      </select>
      <button type="button" aria-label="Zoom in PDF" disabled={!pageCount || zoom >= 300} onClick={() => changeZoom(1.25)}><Plus size={17} /></button>
      <button type="button" className="pdf-preview-fit" disabled={!pageCount}
        onClick={() => { if (viewerRef.current) viewerRef.current.currentScaleValue = 'page-width'; }}>Fit width</button>
    </div>
    <div className="pdf-preview-content">
      {!pageCount && !error && <p className="pdf-preview-message" role="status">Loading PDF…</p>}
      {error && <div className="pdf-preview-message" role="alert">
        <p>This PDF could not be previewed. You can download it or try again.</p>
        <button type="button" onClick={() => { setError(false); setPageCount(0); setAttempt(value => value + 1); }}>Retry preview</button>
      </div>}
      <div ref={containerRef} className="pdf-preview-scroll" aria-label={label} tabIndex={0}>
        <div ref={pagesRef} className="pdfViewer" />
      </div>
    </div>
  </div>;
}
