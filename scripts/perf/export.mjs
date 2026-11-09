#!/usr/bin/env node
/**
 * scripts/perf/export.mjs
 *
 * Exporta el informe de rendimiento (docs/PRUEBAS_RENDIMIENTO.md) a:
 *   - docs/perf/PRUEBAS_RENDIMIENTO.pdf  (vía md-to-pdf con diseño tipográfico)
 *   - docs/perf/PRUEBAS_RENDIMIENTO.docx (vía librería docx con tablas y jerarquía)
 *
 * Ejecutar con:
 *   npm run perf:export
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mdToPdf } from "md-to-pdf";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ShadingType,
} from "docx";

const ROOT = resolve(".");
const MD_PATH = resolve(ROOT, "docs/PRUEBAS_RENDIMIENTO.md");
const OUT_DIR = resolve(ROOT, "docs/perf");
const PDF_PATH = resolve(OUT_DIR, "PRUEBAS_RENDIMIENTO.pdf");
const DOCX_PATH = resolve(OUT_DIR, "PRUEBAS_RENDIMIENTO.docx");

if (!existsSync(MD_PATH)) {
  console.error(`No existe el archivo de origen: ${MD_PATH}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const mdContent = readFileSync(MD_PATH, "utf8");

// =========================================================================
// 1. GENERACIÓN DE PDF
// =========================================================================
async function generatePdf() {
  console.log("Generando PDF...");
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono&display=swap');
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 10pt;
      line-height: 1.6;
      color: #1e293b;
    }
    h1 {
      font-size: 20pt;
      color: #0f172a;
      border-bottom: 2px solid #3b82f6;
      padding-bottom: 8px;
      margin-top: 24px;
      page-break-before: auto;
    }
    h2 {
      font-size: 14pt;
      color: #1e3a8a;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 4px;
      margin-top: 20px;
    }
    h3 {
      font-size: 11pt;
      color: #1e40af;
      margin-top: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font-size: 8.5pt;
      page-break-inside: avoid;
    }
    th {
      background: #1e293b;
      color: #ffffff;
      padding: 6px 8px;
      text-align: left;
      font-weight: 600;
    }
    td {
      padding: 5px 8px;
      border: 1px solid #cbd5e1;
    }
    tr:nth-child(even) td {
      background: #f8fafc;
    }
    pre {
      background: #f1f5f9;
      border-left: 3px solid #3b82f6;
      padding: 10px 12px;
      font-family: 'JetBrains Mono', Consolas, monospace;
      font-size: 8pt;
      border-radius: 4px;
      overflow-x: auto;
      page-break-inside: avoid;
    }
    code {
      font-family: 'JetBrains Mono', Consolas, monospace;
      font-size: 8.5pt;
      background: #f1f5f9;
      padding: 1px 4px;
      border-radius: 3px;
    }
    pre code {
      background: none;
      padding: 0;
    }
    blockquote {
      border-left: 3px solid #60a5fa;
      background: #eff6ff;
      margin: 10px 0;
      padding: 6px 12px;
      color: #1e40af;
      font-size: 9pt;
    }
    hr {
      border: none;
      border-top: 1px solid #e2e8f0;
      margin: 24px 0;
    }
  `;

  await mdToPdf(
    { content: mdContent },
    {
      dest: PDF_PATH,
      css,
      launch_options: {
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
      pdf_options: {
        format: "A4",
        margin: {
          top: "22mm",
          bottom: "22mm",
          left: "22mm",
          right: "22mm",
        },
        displayHeaderFooter: true,
        headerTemplate: '<div style="font-size: 8pt; color: #94a3b8; width: 100%; text-align: right; padding-right: 22mm;">ASTER TIC — Informe de Rendimiento</div>',
        footerTemplate: '<div style="font-size: 8pt; color: #94a3b8; width: 100%; text-align: center;">Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
      },
    }
  );
  console.log(`✓ PDF generado: ${PDF_PATH}`);
}

// =========================================================================
// 2. GENERACIÓN DE WORD (DOCX)
// =========================================================================
function parseInlineRuns(text) {
  const runs = [];
  // Tokeniza negrita, cursiva, código
  const regex = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|([^*`]+))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true, italics: true }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[3], bold: true }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: match[4], italics: true }));
    } else if (match[5]) {
      runs.push(new TextRun({ text: match[5], font: "Consolas", size: 19 }));
    } else if (match[6]) {
      runs.push(new TextRun({ text: match[6] }));
    }
  }
  return runs.length ? runs : [new TextRun({ text })];
}

async function generateDocx() {
  console.log("Generando DOCX...");
  const lines = mdContent.split(/\r?\n/);
  const children = [];

  let inCodeBlock = false;
  let codeBuffer = [];
  let inTable = false;
  let tableRows = [];

  function flushTable() {
    if (!tableRows.length) return;
    const docxRows = tableRows.map((r, rowIndex) => {
      const isHeader = rowIndex === 0;
      return new TableRow({
        tableHeader: isHeader,
        children: r.map((cellText) => {
          return new TableCell({
            children: [
              new Paragraph({
                children: parseInlineRuns(cellText),
                alignment: isHeader ? AlignmentType.LEFT : AlignmentType.LEFT,
              }),
            ],
            shading: isHeader
              ? { type: ShadingType.SOLID, color: "2c3e50" }
              : rowIndex % 2 === 1
              ? { type: ShadingType.SOLID, color: "f8f9fa" }
              : undefined,
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
          });
        }),
      });
    });

    children.push(
      new Table({
        rows: docxRows,
        width: { size: 100, type: WidthType.PERCENTAGE },
      })
    );
    children.push(new Paragraph({ text: "" }));
    tableRows = [];
    inTable = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Bloques de código
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: codeBuffer.join("\n"),
                font: "Consolas",
                size: 18,
              }),
            ],
            shading: { type: ShadingType.SOLID, color: "f4f4f4" },
            spacing: { before: 100, after: 100 },
          })
        );
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        if (inTable) flushTable();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Tablas
    if (line.startsWith("|") && line.endsWith("|")) {
      if (line.match(/^\|[\s\-:|]+\|$/)) {
        // separador
        continue;
      }
      inTable = true;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Encabezados
    if (line.startsWith("# ")) {
      children.push(
        new Paragraph({
          text: line.replace(/^#\s+/, ""),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 300, after: 120 },
        })
      );
      continue;
    }
    if (line.startsWith("## ")) {
      children.push(
        new Paragraph({
          text: line.replace(/^##\s+/, ""),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 100 },
        })
      );
      continue;
    }
    if (line.startsWith("### ")) {
      children.push(
        new Paragraph({
          text: line.replace(/^###\s+/, ""),
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 180, after: 80 },
        })
      );
      continue;
    }

    // Líneas divisorias
    if (line.match(/^---+$/)) {
      children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
      continue;
    }

    // Listas
    if (line.startsWith("- ")) {
      children.push(
        new Paragraph({
          children: parseInlineRuns(line.replace(/^- /, "")),
          bullet: { level: 0 },
          spacing: { after: 60 },
        })
      );
      continue;
    }

    // Líneas vacías
    if (!line.trim()) {
      children.push(new Paragraph({ text: "", spacing: { after: 80 } }));
      continue;
    }

    // Párrafos regulares
    children.push(
      new Paragraph({
        children: parseInlineRuns(line),
        spacing: { after: 120 },
      })
    );
  }

  if (inTable) flushTable();

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,    // 1 pulgada (2.54 cm)
              bottom: 1440,
              left: 1700,   // ~3 cm encuadernación
              right: 1440,
            },
          },
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  writeFileSync(DOCX_PATH, buffer);
  console.log(`✓ DOCX generado: ${DOCX_PATH}`);
}

// =========================================================================
// RUN
// =========================================================================
async function main() {
  console.log("=== Exportando Pruebas de Rendimiento de ASTER ===");
  try {
    await generatePdf();
    await generateDocx();
    console.log("\n¡Exportación completada con éxito!");
    console.log(`  • PDF : ${PDF_PATH}`);
    console.log(`  • DOCX: ${DOCX_PATH}`);
  } catch (err) {
    console.error("Error en la exportación:", err);
    process.exit(1);
  }
}

main();
