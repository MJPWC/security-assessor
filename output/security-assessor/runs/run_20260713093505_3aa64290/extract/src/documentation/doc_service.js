import archiver from 'archiver';
import logger from './logger.js';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripInlineMarkdown(value = '') {
  return String(value)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function textRunXml(text = '', options = {}) {
  const runProps = [];
  if (options.bold) runProps.push('<w:b/>');
  if (options.italic) runProps.push('<w:i/>');
  if (options.code) {
    runProps.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
    runProps.push('<w:shd w:fill="F2F4F7"/>');
  }
  const rPr = runProps.length ? `<w:rPr>${runProps.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function inlineRunsXml(value = '') {
  const text = String(value || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const runs = [];
  const pattern = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(textRunXml(text.slice(lastIndex, match.index)));
    }
    if (match[2]) {
      runs.push(textRunXml(match[2], { bold: true }));
    } else if (match[3]) {
      runs.push(textRunXml(match[3], { italic: true }));
    } else if (match[4]) {
      runs.push(textRunXml(match[4], { code: true }));
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(textRunXml(text.slice(lastIndex)));
  }

  return runs.length ? runs.join('') : textRunXml('');
}

function paragraphPropertiesXml(style = null, options = {}) {
  const props = [];
  if (style) props.push(`<w:pStyle w:val="${style}"/>`);
  if (options.spacing) {
    const before = options.spacing.before ?? 0;
    const after = options.spacing.after ?? 120;
    props.push(`<w:spacing w:before="${before}" w:after="${after}" w:line="276" w:lineRule="auto"/>`);
  }
  if (options.numbering) {
    props.push(`<w:numPr><w:ilvl w:val="${options.numbering.level || 0}"/><w:numId w:val="${options.numbering.numId}"/></w:numPr>`);
  }
  if (options.borderBottom) {
    props.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9D9D9"/></w:pBdr>');
  }
  return props.length ? `<w:pPr>${props.join('')}</w:pPr>` : '';
}

function paragraphXml(text = '', style = null, options = {}) {
  return `<w:p>${paragraphPropertiesXml(style, { spacing: true, ...options })}${inlineRunsXml(text)}</w:p>`;
}

function listXml(text = '', numId = 1, level = 0) {
  return paragraphXml(text, 'ListParagraph', {
    numbering: { numId, level },
    spacing: { before: 0, after: 80 }
  });
}

function parseTableRow(line = '') {
  return line
    .split('|')
    .map(cell => stripInlineMarkdown(cell))
    .filter(Boolean);
}

function tableXml(rows = []) {
  if (!rows.length) return '';
  const columnCount = Math.max(...rows.map(row => row.length));
  const width = Math.floor(9000 / Math.max(columnCount, 1));
  const tableCellParagraphXml = (cell = '', isHeader = false) =>
    `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${
      isHeader ? textRunXml(cell, { bold: true }) : inlineRunsXml(cell)
    }</w:p>`;
  const rowXml = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columnCount }, (_, index) => row[index] || '');
    return `<w:tr>${cells.map(cell => `
      <w:tc>
        <w:tcPr>
          <w:tcW w:w="${width}" w:type="dxa"/>
          <w:tcBorders>
            <w:top w:val="single" w:sz="4" w:color="D9D9D9"/>
            <w:left w:val="single" w:sz="4" w:color="D9D9D9"/>
            <w:bottom w:val="single" w:sz="4" w:color="D9D9D9"/>
            <w:right w:val="single" w:sz="4" w:color="D9D9D9"/>
          </w:tcBorders>
          ${rowIndex === 0 ? '<w:shd w:fill="F2F4F7"/>' : ''}
        </w:tcPr>
        ${tableCellParagraphXml(cell, rowIndex === 0)}
      </w:tc>`).join('')}</w:tr>`;
  }).join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblStyle w:val="TableGrid"/>
      <w:tblW w:w="0" w:type="auto"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="D9D9D9"/>
        <w:left w:val="single" w:sz="4" w:color="D9D9D9"/>
        <w:bottom w:val="single" w:sz="4" w:color="D9D9D9"/>
        <w:right w:val="single" w:sz="4" w:color="D9D9D9"/>
        <w:insideH w:val="single" w:sz="4" w:color="D9D9D9"/>
        <w:insideV w:val="single" w:sz="4" w:color="D9D9D9"/>
      </w:tblBorders>
    </w:tblPr>
    ${rowXml}
  </w:tbl>`;
}

function isTableSeparator(line = '') {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}

function isMarkdownTableLine(line = '') {
  return line.includes('|') && parseTableRow(line).length > 1;
}

function documentHeadingFromPlainLine(line = '') {
  const trimmed = line.trim();
  const numbered = trimmed.match(/^(\d+(?:\.\d+)*)[.)]?\s+(.{3,90})$/);
  if (!numbered) return null;

  const title = numbered[2].trim();
  const wordCount = title.split(/\s+/).length;
  const looksLikeTitle =
    wordCount <= 12 &&
    /^[A-Z0-9]/.test(title) &&
    !/[.!?]$/.test(title);

  if (!looksLikeTitle) return null;

  const level = numbered[1].includes('.') ? 3 : 2;
  return { level, title };
}

function markdownToDocumentBody(markdownText = '') {
  const lines = String(markdownText || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let inCodeBlock = false;
  let tableRows = [];

  const flushTable = () => {
    if (tableRows.length > 0) {
      blocks.push(tableXml(tableRows));
      tableRows = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^```/.test(line)) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (!line) {
      flushTable();
      blocks.push(paragraphXml(''));
      continue;
    }

    if (inCodeBlock) {
      blocks.push(paragraphXml(rawLine, 'CodeBlock', { spacing: { before: 0, after: 80 } }));
      continue;
    }

    if (isTableSeparator(line)) {
      continue;
    }

    if (isMarkdownTableLine(line)) {
      tableRows.push(parseTableRow(line));
      continue;
    }

    flushTable();

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      blocks.push(paragraphXml(heading[2], `Heading${level}`));
      continue;
    }

    const plainHeading = documentHeadingFromPlainLine(line);
    if (plainHeading) {
      blocks.push(paragraphXml(plainHeading.title, `Heading${plainHeading.level}`));
      continue;
    }

    if (/^[-*_]{3,}$/.test(line)) {
      blocks.push(`<w:p>${paragraphPropertiesXml(null, { borderBottom: true, spacing: { before: 120, after: 120 } })}</w:p>`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bullet) {
      const level = Math.min(Math.floor((bullet[1] || '').length / 2), 2);
      blocks.push(listXml(bullet[2], 1, level));
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      blocks.push(listXml(numbered[1], 2, 0));
      continue;
    }

    blocks.push(paragraphXml(line));
  }

  flushTable();
  return blocks.filter(Boolean).join('');
}

async function zipDocx(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];

    archive.on('data', chunk => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    for (const [path, content] of files) {
      archive.append(content, { name: path });
    }

    archive.finalize();
  });
}

function buildDocumentXml(markdownText) {
  const body = markdownToDocumentBody(markdownText);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="220" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="180" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="80" w:after="80"/><w:shd w:fill="F2F4F7"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9D9D9"/><w:left w:val="single" w:sz="4" w:color="D9D9D9"/><w:bottom w:val="single" w:sz="4" w:color="D9D9D9"/><w:right w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideH w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideV w:val="single" w:sz="4" w:color="D9D9D9"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="bullet"/>
      <w:lvlText w:val="&#8226;"/>
      <w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:abstractNum w:abstractNumId="2">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
      <w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`;

export async function convertMarkdownToWord(markdownText) {
  logger.info('[doc_service] Converting markdown to Word locally.');

  try {
    const data = await zipDocx([
      ['[Content_Types].xml', contentTypesXml],
      ['_rels/.rels', rootRelsXml],
      ['word/_rels/document.xml.rels', documentRelsXml],
      ['word/document.xml', buildDocumentXml(markdownText)],
      ['word/styles.xml', stylesXml],
      ['word/numbering.xml', numberingXml]
    ]);

    return {
      success: true,
      data,
      contentType: DOCX_CONTENT_TYPE,
      filename: 'document.docx'
    };
  } catch (error) {
    const message = error?.message || 'Failed to create Word document locally';
    logger.error('[doc_service] Local Word conversion error:', message);
    return { success: false, error: message, data: null };
  }
}
