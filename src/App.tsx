import { useEffect, useState } from "react";
import mammoth from "mammoth";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import juwCampus from "./assets/juw-campus-real.jpg";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

type Page = "home" | "about" | "faculty" | "curriculum" | "research" | "events";
type View = Page | "admin-login" | "admin-dashboard";
type AdminRole = "main" | "department";
type DocumentCategory = "curriculum" | "faculty" | "research" | "events";

type PublishedDocument = {
  id: string;
  name: string;
  category: DocumentCategory;
  type: "PDF" | "DOCX" | "DOC";
  html: string;
  text: string;
  size: number;
  uploadedAt: string;
  uploadedBy: string;
  designation?: string;
  sourceDataUrl?: string;
  fileUrl?: string;
  textUrl?: string;
};

type AdminSession = {
  role: AdminRole;
  username: string;
};

const documentStorageKey = "juw-biochemistry-published-documents";
const documentDatabaseName = "juw-biochemistry-document-database";
const documentStoreName = "published";
const adminSessionKey = "juw-biochemistry-admin-session";
const adminAccounts: Record<string, { password: string; role: AdminRole }> = {
  mainadmin: { password: "biochem2026", role: "main" },
  deptadmin: { password: "biochem2026", role: "department" },
};

const facultyDesignations = [
  "Professor & Chairperson",
  "Professor",
  "Assistant Professor, Director Publications",
  "Assistant Professor",
  "Lecturer",
];

function loadPublishedDocuments(): PublishedDocument[] {
  try {
    const stored = localStorage.getItem(documentStorageKey);
    return stored ? (JSON.parse(stored) as PublishedDocument[]) : [];
  } catch {
    return [];
  }
}

function openDocumentDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(documentDatabaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(documentStoreName)) request.result.createObjectStore(documentStoreName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredDocuments() {
  if (!("indexedDB" in window)) return [];
  const database = await openDocumentDatabase();
  return new Promise<PublishedDocument[]>((resolve, reject) => {
    const request = database.transaction(documentStoreName, "readonly").objectStore(documentStoreName).get("all");
    request.onsuccess = () => {
      database.close();
      resolve((request.result as PublishedDocument[] | undefined) ?? []);
    };
    request.onerror = () => {
      database.close();
      reject(request.error);
    };
  });
}

async function writeStoredDocuments(documents: PublishedDocument[]) {
  if (!("indexedDB" in window)) return;
  const database = await openDocumentDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(documentStoreName, "readwrite");
    transaction.objectStore(documentStoreName).put(documents, "all");
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

function persistDocuments(documents: PublishedDocument[]) {
  try {
    localStorage.setItem(documentStorageKey, JSON.stringify(documents));
  } catch {
    // IndexedDB below remains the durable copy when localStorage is full.
  }
  void writeStoredDocuments(documents).catch(() => undefined);
}

function loadAdminSession(): AdminSession | null {
  try {
    const stored = sessionStorage.getItem(adminSessionKey);
    return stored ? (JSON.parse(stored) as AdminSession) : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

function sanitizeDocumentHtml(value: string) {
  const parsed = new DOMParser().parseFromString(`<div>${value}</div>`, "text/html");
  parsed.querySelectorAll("script, iframe, object, embed, style, link, meta").forEach((element) => element.remove());
  parsed.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const isSafeAttribute = ["href", "src", "alt", "title", "colspan", "rowspan"].includes(attribute.name);
      const isSafeUrl = !["href", "src"].includes(attribute.name) || /^(https?:|data:image\/)/i.test(attribute.value);
      if (!isSafeAttribute || !isSafeUrl) element.removeAttribute(attribute.name);
    });
  });
  return parsed.body.firstElementChild?.innerHTML ?? "";
}

function textAsHtml(text: string) {
  return `<div class="document-plain-text">${text.split("\n").map((line) => `<p>${line ? escapeHtml(line) : "&nbsp;"}</p>`).join("")}</div>`;
}

function curriculumDisplayHtml(document: PublishedDocument) {
  if (/<table[\s>]/i.test(document.html)) return document.html;
  return `<div class="curriculum-text-table">${document.text.split("\n").map((line) => `<div class="curriculum-text-row">${line ? escapeHtml(line) : "&nbsp;"}</div>`).join("")}</div>`;
}

function compactPublicationHtml(document: PublishedDocument) {
  if (/<table[\s>]/i.test(document.html)) return document.html;
  const lines = document.text.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = lines[0] ?? document.name;
  const details = lines.slice(1).join(" ");
  return `<div class="publication-text-content"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(details || document.name)}</p></div>`;
}

async function extractPdfText(file: File) {
  const pdf = await getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => {
      if (!("str" in item)) return "";
      return `${item.str}${item.hasEOL ? "\n" : " "}`;
    }).join("").trim();
    pages.push(text);
    page.cleanup();
  }
  await pdf.destroy();
  return pages.join("\n\n");
}

async function convertUploadedFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") {
    const text = await extractPdfText(file);
    return { type: "PDF" as const, text, html: textAsHtml(text) };
  }
  if (extension === "docx") {
    const arrayBuffer = await file.arrayBuffer();
    const [converted, raw] = await Promise.all([
      mammoth.convertToHtml({ arrayBuffer }),
      mammoth.extractRawText({ arrayBuffer }),
    ]);
    return { type: "DOCX" as const, text: raw.value, html: sanitizeDocumentHtml(converted.value) };
  }
  if (extension === "doc") {
    const text = await file.text();
    return { type: "DOC" as const, text, html: textAsHtml(text) };
  }
  throw new Error("Please choose a PDF or Word document (.pdf, .docx, or .doc).");
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be stored."));
    reader.readAsDataURL(file);
  });
}

async function getBackendDocuments() {
  try {
    const response = await fetch("/api/documents", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return await response.json() as PublishedDocument[];
  } catch {
    return null;
  }
}

const navItems: { label: string; page: Page }[] = [
  { label: "Home", page: "home" },
  { label: "About", page: "about" },
  { label: "Faculty", page: "faculty" },
  { label: "Curriculum", page: "curriculum" },
  { label: "Research", page: "research" },
  { label: "Events & News", page: "events" },
  { label: "Lab Tools", page: "home" },
];

function Icon({ name, size = 15, className = "" }: { name: string; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };

  const paths: Record<string, React.ReactNode> = {
    building: (
      <>
        <path d="M4 21V5l8-3 8 3v16" />
        <path d="M2 21h20M8 9h1M15 9h1M8 13h1M15 13h1M8 17h1M15 17h1" />
      </>
    ),
    eye: (
      <>
        <path d="M2.5 12s3.1-5 9.5-5 9.5 5 9.5 5-3.1 5-9.5 5-9.5-5-9.5-5Z" />
        <circle cx="12" cy="12" r="2.2" />
      </>
    ),
    mission: (
      <>
        <path d="M5 4h14v14H5z" />
        <path d="m8 15 2.6-3.1 2.2 2 2.2-3 2 2.1" />
        <path d="M8 8h.01M12 8h4" />
      </>
    ),
    star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
    lab: (
      <>
        <path d="M9 3v6l-4.5 8.4A1.8 1.8 0 0 0 6.1 20h11.8a1.8 1.8 0 0 0 1.6-2.6L15 9V3" />
        <path d="M7.5 3h9M8.2 15h7.6" />
      </>
    ),
    university: (
      <>
        <path d="M3 9.5 12 4l9 5.5" />
        <path d="M4.5 9.5h15" />
        <path d="M6.5 12.5v5M10 12.5v5M14 12.5v5M17.5 12.5v5" />
        <path d="M4.5 17.5h15M3.5 20.5h17" />
      </>
    ),
    flask: (
      <>
        <path d="M9 3h6M10 3v6l-5.8 9.5A1.6 1.6 0 0 0 5.6 21h12.8a1.6 1.6 0 0 0 1.4-2.5L14 9V3" />
        <path d="M7.2 16h9.6" />
      </>
    ),
    briefcase: (
      <>
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2" />
      </>
    ),
    network: (
      <>
        <circle cx="12" cy="5" r="2" />
        <circle cx="5" cy="18" r="2" />
        <circle cx="19" cy="18" r="2" />
        <path d="m10.9 6.7-4.8 9.6M13.1 6.7l4.8 9.6M7 18h10" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M5 12h13m-5-5 5 5-5 5" />,
    award: (
      <>
        <circle cx="12" cy="9" r="5" />
        <path d="m8.8 13.1-1 7 4.2-2 4.2 2-1-7" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="4.5" width="18" height="17" rx="2" />
        <path d="M7 2.5v4M17 2.5v4M3 9h18" />
      </>
    ),
    download: <path d="M12 3v12m-4-4 4 4 4-4M4 20h16" />,
  };

  return <svg {...common}>{paths[name] ?? paths.flask}</svg>;
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`}>
      <span className="brand-mark" aria-hidden="true">
        <img className="university-logo" src="https://images.seeklogo.com/logo-png/35/1/jinnah-university-for-women-logo-png_seeklogo-350109.png" alt="Jinnah University for Women logo" />
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>Dept. of Biochemistry</strong>
          <small>FACULTY OF BIOLOGICAL SCIENCES</small>
        </span>
      )}
    </div>
  );
}

function Header({ current, onNavigate, onInquire }: { current: Page; onNavigate: (page: Page) => void; onInquire: () => void }) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <button className="brand-button" onClick={() => onNavigate("home")} aria-label="Department of Biochemistry home">
          <BrandMark />
        </button>
        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              key={item.label}
              className={current === item.page && item.page !== "home" ? "active" : current === "home" && item.label === "Home" ? "active" : ""}
              onClick={() => onNavigate(item.page)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <button className="inquire-button" onClick={onInquire}>Inquire Now</button>
      </div>
    </header>
  );
}

function Footer({ adminSession, onAdminAccess }: { adminSession: AdminSession | null; onAdminAccess: () => void }) {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-top">
          <div className="footer-identity">
            <BrandMark compact />
            <span>Department of Biochemistry - Jinnah University for Women</span>
          </div>
          <div className="socials" aria-label="Social links">
            <a href="https://www.juw.edu.pk/" target="_blank" rel="noreferrer" aria-label="Official website">o</a>
            <a href="https://www.facebook.com/juwofficialpage/" target="_blank" rel="noreferrer" aria-label="Facebook">f</a>
            <a href="https://www.instagram.com/juw_official" target="_blank" rel="noreferrer" aria-label="Instagram">t</a>
          </div>
        </div>
        <div className="footer-bottom">
          <span className="footer-bottom-right"><span>Faculty of Biological Sciences</span><button type="button" className="footer-admin-link" onClick={onAdminAccess}>{adminSession ? "Admin Dashboard" : "Admin Login"}</button></span>
        </div>
        <div className="footer-credits">
          <div className="credits-top">
            <span className="nz-logos-logo" aria-label="nz.logos logo"><span className="nz-mark">nz</span><span className="nz-word">.logos</span></span>
            <span className="credits-line">Web Solutions &amp; Digital Services Provider by <a href="https://www.instagram.com/nz.logos" target="_blank" rel="noreferrer">nz.logos</a></span>
            <span className="credits-contact">Contact Us: <a href="https://www.instagram.com/nz.logos" target="_blank" rel="noreferrer">https://www.instagram.com/nz.logos</a></span>
          </div>
          <div className="credits-bottom">
            <span>&copy; 2026 <b>[FabiyaSultani]</b>. All rights reserved. Created for the Department of Biochemistry - Jinnah University for Women</span>
            <span>Designed &amp; Developed by <b>FABIYA SULTANI</b> &bull; Need a site? Contact <a href="https://www.instagram.com/nz.logos" target="_blank" rel="noreferrer">@nz.logos</a> on Instagram</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

function SectionTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div className="section-title">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

function HomePage() {
  return (
    <main className="home-page page-shell">
      <section className="hero-section">
        <div className="hero-campusescape" style={{ backgroundImage: `url(${juwCampus})` }} aria-hidden="true" />
        <div className="hero-content">
          <div className="hero-copy reveal">
            <span className="institution-tag"><Icon name="building" size={11} /> Jinnah University for Women</span>
            <h1>Advancing Female<br />Leadership in<br /><em>Biochemical Sciences</em></h1>
            <p>Welcome to the Department of Biochemistry. Established in 1998, we<br className="desktop-break" /> foster scientific innovation, cutting-edge laboratory inquiry, and ethical<br className="desktop-break" /> excellence.</p>
            <div className="hero-actions">
              <a className="button button-primary" href="#curriculum">Explore Curriculum <Icon name="arrow" size={12} /></a>
              <a className="button button-secondary" href="#about">Read Department Profile</a>
            </div>
          </div>
          <div className="stats-panel reveal delay-one">
            <div className="established"><span className="award-icon"><Icon name="award" size={16} /></span><span><b>Established</b><strong>1998 Beacon of Excellence</strong></span></div>
            <div className="stats-grid">
              <div><strong>05</strong><span>Degree Pathways</span></div>
              <div><strong>50+</strong><span>PhD Workstreams</span></div>
              <div><strong>100%</strong><span>Ph.D. &amp; M.Phil. Faculty</span></div>
              <div><strong>3 Track</strong><span>Specializations</span></div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function AboutPage({ onApply }: { onApply: () => void }) {
  const strengths = [
    "A faculty of accomplished Ph.D. and M.Phil. scientists invested in teaching and mentoring.",
    "A curriculum continuously updated with input from industry professionals and academic experts.",
    "Hands-on exposure to Artificial Intelligence through a dedicated course and AI-assisted lab work.",
    "Purpose-built research and molecular biology laboratories and a computer lab for data-driven science.",
    "Direct pipelines to internships, capstone projects and employment opportunities through an active Industry Advisory Board and hospital, pharma, and research partners.",
  ];

  return (
    <main className="content-page about-page page-shell">
      <div className="about-container">
        <div className="about-banner">
          <h1>JINNAH UNIVERSITY FOR WOMEN</h1>
          <h2>DEPARTMENT OF BIOCHEMISTRY</h2>
        </div>
        <section className="info-panel intro-panel">
          <h3><Icon name="building" /> Introduction</h3>
          <p>Established in 1998, the Department of Biochemistry at Jinnah University for Women has emerged as a beacon of excellence in both education and research, offering aspiring female scientists a nurturing yet challenging environment in which to build a rewarding career in the life sciences. The department proudly hosts a diverse and highly qualified faculty who are dedicated to mentoring the next generation of biochemists and molecular biologists.</p>
        </section>
        <div className="two-column">
          <section className="info-panel">
            <h3><Icon name="eye" /> Vision</h3>
            <p>The Department of Biochemistry at Jinnah University for Women envisions a future where scientific innovation and ethical excellence converge to shape a better world. The aspiration is to become a global leader in Biochemistry education and research, empowering women to excel in the dynamic fields of life sciences.</p>
          </section>
          <section className="info-panel">
            <h3><Icon name="mission" /> Mission</h3>
            <p>The Department of Biochemistry at Jinnah University for Women is dedicated to providing an inclusive learning environment that cultivates critical thinking, ethical responsibility, and a lifelong passion for Biochemistry. Through high-quality education and innovative research, the department addresses local and global challenges in health, the environment, and society. By leveraging faculty expertise and fostering a collaborative academic culture, it aims to advance scientific knowledge, promote societal well-being, and prepare students for meaningful contributions in their fields.</p>
          </section>
        </div>
        <section className="info-panel strengths-panel">
          <h3><Icon name="star" /> Departmental Strengths and Rationale</h3>
          <ul className="check-list">
            {strengths.map((strength) => <li key={strength}><Icon name="check" />{strength}</li>)}
          </ul>
        </section>
        <section className="info-panel programme-panel">
          <h3><Icon name="briefcase" /> Programme Offered</h3>
          <div className="programme-table">
            <div className="programme-row table-head"><span>Degree Programme</span><span>Duration</span></div>
            <div className="programme-row"><span>BS in Biochemistry with specializations in:<small>1. Human Pathophysiology and Clinical Diagnostics<br />2. Applied Biochemistry and Biotechnology<br />3. Bioinformatics</small></span><b>4 Years</b></div>
            <div className="programme-row"><span>BS in Molecular Biology</span><b>4 Years</b></div>
            <div className="programme-row"><span>Associate Degree (AD) in Molecular Biology</span><b>2 Years</b></div>
            <div className="programme-row"><span>MS in Biochemistry</span><b>2-4 Years</b></div>
            <div className="programme-row"><span>PhD in Biochemistry</span><b>3-6 Years</b></div>
          </div>
        </section>
        <section className="info-panel ai-panel">
          <h3><Icon name="network" /> Curriculum Modernization and Integration of Artificial Intelligence</h3>
          <p>The discipline of Biochemistry has expanded beyond traditional laboratory-based practice to encompass data-driven, automated, and computationally intensive methodologies, necessitating a corresponding evolution in curriculum design. In consultation with industry professionals and academic experts, the programme has incorporated a dedicated course in the Foundations of Artificial Intelligence alongside AI-assisted laboratory instruction, thereby equipping graduates with computational competencies that are increasingly regarded as indispensable to contemporary biochemical practice. This modernization is further reflected in the introduction of real-year specialization tracks - Human Pathophysiology and Clinical Diagnostics, Applied Biochemistry and Biotechnology, and Bioinformatics - allowing students to pursue advanced, industry-aligned expertise within their chosen area of interest.</p>
        </section>
        <section className="info-panel infrastructure-panel">
          <h3><Icon name="flask" /> Research and Laboratory Infrastructure</h3>
          <ul className="infra-list">
            <li><Icon name="building" /><span><b>Dedicated Laboratories for BS, I &amp; II:</b> well-equipped teaching labs that build foundational bench skills from the very first semester.</span></li>
            <li><Icon name="flask" /><span><b>Research Lab for BS FYs, MS &amp; Ph.D. Students:</b> a dedicated space for independent, advanced inquiry.</span></li>
            <li><Icon name="network" /><span><b>Molecular Biology &amp; PCR Labs:</b> enabling precision DNA amplification and analysis for genomics and diagnostics.</span></li>
            <li><Icon name="briefcase" /><span><b>50+ Workstations Computer Labs:</b> building fluency in Artificial Intelligence, Computational Biology, Proteomics &amp; Genomics, Bioinformatics and Data-Analysis tools driving modern Biochemistry.</span></li>
          </ul>
        </section>
        <section className="info-panel career-panel">
          <h3><Icon name="briefcase" /> Career Opportunities</h3>
          <p>Biochemists have diverse career opportunities including but not limited to:</p>
          <div className="career-grid">
            <span>Academic institutions (Universities, colleges, and schools)</span>
            <span>Pharmaceutical companies and biotechnology firms</span>
            <span>Hospitals and clinical pathology laboratories</span>
            <span>Clinical research organizations</span>
            <span>Forensic laboratories</span>
            <span>Government research agencies</span>
            <span>The environmental sector</span>
            <span>Patent and intellectual property firms</span>
            <span className="full-width">Industry more broadly, from manufacturing to R&amp;D</span>
          </div>
        </section>
        <section className="info-panel network-panel">
          <h3><Icon name="network" /> Professional Network and Industry Partnerships</h3>
          <div className="partner-grid">
            <span>Al Gohar Pharmaceuticals (AGP)</span>
            <span>PCSIR Laboratories Complex</span>
            <span>Popular Group of Industries</span>
            <span>Dept. of Molecular Pathology, Liaquat National Hospital</span>
            <span>Jinnah Postgraduate Medical Centre</span>
            <span>Civil Hospital, Karachi</span>
            <span className="full-width">ICCBS, University of Karachi</span>
          </div>
        </section>
        <section className="next-step-panel">
          <h2>Take the Next Step</h2>
          <p>Admission to the Department of Biochemistry is an invitation to think differently about science - and<br className="desktop-break" /> about what a woman scientist from Jinnah University for Women can go on to build. The department<br className="desktop-break" /> looks forward to welcoming its next generation of scholars.</p>
          <button className="button button-primary" onClick={onApply}>Apply for Admission <Icon name="arrow" size={12} /></button>
        </section>
      </div>
    </main>
  );
}

function DocBadge({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span className="doc-type-badge" aria-hidden="true">
      <Icon name={name} size={size} />
    </span>
  );
}

function badgeIconFor(category: DocumentCategory) {
  if (category === "research") return "flask";
  if (category === "curriculum") return "briefcase";
  if (category === "faculty") return "university";
  return "calendar";
}

function PublishedDocuments({ category, documents, title }: { category: DocumentCategory; documents: PublishedDocument[]; title: string }) {
  const matchingDocuments = documents.filter((document) => document.category === category);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  if (matchingDocuments.length === 0) return null;

  const visibleDocuments = category === "faculty"
    ? [...matchingDocuments].sort((first, second) => {
      const firstRank = first.designation ? facultyDesignations.indexOf(first.designation) : facultyDesignations.length;
      const secondRank = second.designation ? facultyDesignations.indexOf(second.designation) : facultyDesignations.length;
      return firstRank - secondRank;
    })
    : matchingDocuments;
  const activeDocument = visibleDocuments.find((document) => document.id === activeDocumentId);
  const usesDocumentCards = category === "curriculum" || category === "research" || category === "events";
  const documentTypeLabel = category === "research" ? "Research paper" : category === "events" ? "Event or news" : "Curriculum document";

  return (
    <section className={`published-documents ${category === "curriculum" ? "curriculum-documents" : ""}`}>
      <div className="published-documents-heading">
        <span className="eyebrow">Published Documents</span>
        <h2>{title}</h2>
        <p>Documents published by the department, presented in the department format.</p>
      </div>
      {usesDocumentCards && !activeDocument ? (
        <div className="document-card-list">
          {visibleDocuments.map((document) => (
            <article className="document-card" key={document.id}>
              <DocBadge name={badgeIconFor(category)} />
              <div className="document-card-type">{document.type}</div>
              <div className="document-card-copy"><h3>{document.name}</h3><p>{documentTypeLabel} - uploaded {new Date(document.uploadedAt).toLocaleDateString()}</p></div>
              <button className="document-view-button" type="button" onClick={() => setActiveDocumentId(document.id)}>View <Icon name="arrow" size={12} /></button>
            </article>
          ))}
        </div>
      ) : (
        <div className="document-list">
          {(activeDocument ? [activeDocument] : visibleDocuments).map((document) => (
            <article className={`document-page ${category === "curriculum" ? "curriculum-document-page" : ""}`} key={document.id}>
              <div className="doc-rail"><DocBadge name={badgeIconFor(category)} /></div>
              <div className="document-page-body">
                {usesDocumentCards && <button className="document-back-button" type="button" onClick={() => setActiveDocumentId(null)}>&larr; Back to {title}</button>}
                <div className="document-page-meta">{category === "faculty" && <em className="faculty-designation">{document.designation ?? facultyDesignations[visibleDocuments.indexOf(document)] ?? "Lecturer"}</em>}<span>{document.type}</span><strong>{document.name}</strong><small>Uploaded {new Date(document.uploadedAt).toLocaleDateString()}</small></div>
                {category === "faculty" && document.type === "PDF" && (document.sourceDataUrl || document.fileUrl) ? (
                  <div className="faculty-pdf-viewer"><iframe src={document.sourceDataUrl || document.fileUrl} title={`${document.name} faculty CV`} /></div>
                ) : (
                  <div className="document-html" dangerouslySetInnerHTML={{ __html: category === "curriculum" ? curriculumDisplayHtml(document) : category === "research" || category === "events" ? compactPublicationHtml(document) : document.html }} />
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function FacultyPage({ documents }: { documents: PublishedDocument[] }) {
  return (
    <main className="content-page faculty-page page-shell">
      <div className="faculty-container">
        <SectionTitle eyebrow="Academic Mentorship Leaders" title="Meet the Faculty" subtitle="Accomplished Ph.D. and M.Phil. scientists dedicated to mentoring the next generation of biochemists." />
        <PublishedDocuments category="faculty" documents={documents} title="Faculty CVs" />
      </div>
    </main>
  );
}

function CurriculumPage({ documents }: { documents: PublishedDocument[] }) {
  return (
    <main className="content-page curriculum-page page-shell">
      <div className="curriculum-container">
        <SectionTitle eyebrow="Academic Pathways" title="Curriculum & Programs Offered" subtitle="Comprehensive degree courses designed according to international accreditation benchmarks." />
        <PublishedDocuments category="curriculum" documents={documents} title="Curriculum Documents" />
      </div>
    </main>
  );
}

function ResearchPage({ documents }: { documents: PublishedDocument[] }) {
  return (
    <main className="content-page research-page page-shell">
      <div className="research-container">
        <SectionTitle eyebrow="Scientific Contributions" title="Research & Publications" subtitle="Discover recent scientific publications and ongoing research initiatives in biological chemistry." />
        <PublishedDocuments category="research" documents={documents} title="Uploaded Research Papers" />
      </div>
    </main>
  );
}

function EventsPage({ documents }: { documents: PublishedDocument[] }) {
  return (
    <main className="content-page events-page page-shell">
      <div className="events-container">
        <SectionTitle eyebrow="Department Updates" title="Events & News" subtitle="Upcoming academic seminars, workshops, and student achievements." />
        <PublishedDocuments category="events" documents={documents} title="Uploaded Events & News" />
      </div>
    </main>
  );
}

function InquiryModal({ onClose }: { onClose: () => void }) {
  const [submitted, setSubmitted] = useState(false);

  const submitInquiry = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="inquiry-modal" role="dialog" aria-modal="true" aria-labelledby="inquiry-title">
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close inquiry form">x</button>
        {!submitted ? (
          <>
            <span className="eyebrow">Department Inquiry</span>
            <h2 id="inquiry-title">Start Your Biochemistry Journey</h2>
            <p>Send the department a quick message and our admissions team will get back to you.</p>
            <form onSubmit={submitInquiry}>
              <label>Name<input name="name" required placeholder="Your name" /></label>
              <label>Email<input name="email" type="email" required placeholder="you@example.com" /></label>
              <label>Message<textarea name="message" required placeholder="How can we help?" rows={3} /></label>
              <button className="button button-primary" type="submit">Send Inquiry <Icon name="arrow" size={12} /></button>
            </form>
          </>
        ) : (
          <div className="inquiry-success">
            <span className="success-mark"><Icon name="check" size={20} /></span>
            <h2 id="inquiry-title">Inquiry Received</h2>
            <p>Thank you. The Department of Biochemistry will be in touch soon.</p>
            <button className="button button-primary" type="button" onClick={onClose}>Close</button>
          </div>
        )}
      </section>
    </div>
  );
}

function AdminLoginPage({ onLogin }: { onLogin: (session: AdminSession) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submitLogin = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const account = adminAccounts[username.trim().toLowerCase()];
    if (!account || account.password !== password) {
      setError("The admin username or password is not correct.");
      return;
    }
    const session = { username: username.trim().toLowerCase(), role: account.role };
    sessionStorage.setItem(adminSessionKey, JSON.stringify(session));
    onLogin(session);
  };

  return (
    <main className="admin-page login-page page-shell">
      <div className="admin-login-panel">
        <BrandMark />
        <span className="eyebrow">Secure Admin Portal</span>
        <h1>Department Administration</h1>
        <p>Sign in as the Main Admin or Department Admin to publish curriculum documents and faculty CVs.</p>
        <form className="admin-form" onSubmit={submitLogin}>
          <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required placeholder="Admin username" /></label>
          <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required placeholder="Admin password" /></label>
          {error && <div className="admin-error">{error}</div>}
          <button className="button button-primary" type="submit">Sign In <Icon name="arrow" size={12} /></button>
        </form>
        <button className="admin-back-link" type="button" onClick={() => { window.location.hash = "home" }}>Return to website</button>
      </div>
    </main>
  );
}

function UploadCard({ category, onUpload }: { category: DocumentCategory; onUpload: (file: File, category: DocumentCategory, designation?: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [designation, setDesignation] = useState(category === "faculty" ? facultyDesignations[0] : "");
  const label = category === "curriculum"
    ? "Curriculum PDF or Word document"
    : category === "faculty"
      ? "Faculty CV PDF or Word document"
      : category === "research"
        ? "Research Paper PDF or Word document"
        : "Events & News PDF or Word document";

  const submitUpload = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file) {
      setStatus("Choose a document first.");
      return;
    }
    setStatus("Reading document...");
    try {
      await onUpload(file, category, category === "faculty" ? designation : undefined);
      setFile(null);
      setDesignation(category === "faculty" ? facultyDesignations[0] : "");
      form.reset();
      setStatus("Published successfully.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The document could not be published.");
    }
  };

  return (
    <form className="upload-card" onSubmit={submitUpload}>
      <div className="upload-card-icon"><Icon name={category === "curriculum" ? "briefcase" : category === "research" ? "flask" : category === "events" ? "calendar" : "building"} size={18} /></div>
      <div className="upload-card-copy"><h3>{label}</h3><p>Upload a PDF, DOCX, or DOC. The document text will be kept and displayed on the public {category} page.</p></div>
      {category === "faculty" && <label className="designation-field">Designation<select value={designation} onChange={(event) => setDesignation(event.target.value)} required>{facultyDesignations.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>}
      <input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <div className="upload-card-footer"><span>{file ? file.name : "No file selected"}</span><button className="button button-primary" type="submit">Upload &amp; Publish</button></div>
      {status && <small className={status.includes("success") ? "upload-success" : "upload-status"}>{status}</small>}
    </form>
  );
}

function AdminDashboardPage({ session, documents, onUpload, onDelete, onLogout }: { session: AdminSession; documents: PublishedDocument[]; onUpload: (file: File, category: DocumentCategory, designation?: string) => Promise<void>; onDelete: (id: string) => void; onLogout: () => void }) {
  const roleLabel = session.role === "main" ? "Main Admin" : "Department Admin";

  return (
    <main className="admin-page dashboard-page page-shell">
      <div className="dashboard-container">
        <div className="dashboard-topbar">
          <div className="dashboard-brand"><BrandMark /><span><small>Signed in as</small><strong>{roleLabel}</strong></span></div>
          <div className="dashboard-actions"><a href="#home" className="admin-site-link">View website</a><button className="admin-logout" type="button" onClick={onLogout}>Log out</button></div>
        </div>
        <div className="dashboard-heading"><div><span className="eyebrow">{session.role === "main" ? "Main Administration" : "Department Administration"}</span><h1>{roleLabel} Dashboard</h1><p>Upload, publish, and manage the documents shown in the public website.</p></div><div className="dashboard-count"><strong>{documents.length}</strong><span>Published documents</span></div></div>
        <div className="upload-grid">
          <UploadCard category="curriculum" onUpload={onUpload} />
          <UploadCard category="faculty" onUpload={onUpload} />
          <UploadCard category="research" onUpload={onUpload} />
          <UploadCard category="events" onUpload={onUpload} />
        </div>
        <section className="admin-library">
          <div className="admin-library-heading"><div><span className="eyebrow">Document Library</span><h2>Published Content</h2></div><span>{documents.length} total</span></div>
          {documents.length === 0 ? <div className="empty-library">No documents have been published yet. Upload a curriculum or faculty CV above.</div> : (
            <div className="admin-document-table">
              {documents.map((document) => (
                <div className="admin-document-row" key={document.id}>
                  <div><b>{document.name}</b><span>{document.category === "curriculum" ? "Curriculum" : document.category === "faculty" ? "Faculty CV" : document.category === "research" ? "Research Paper" : "Events & News"} - {document.type} - uploaded by {document.uploadedBy}</span>{document.fileUrl && <span className="stored-file-links"><a href={document.fileUrl} target="_blank" rel="noreferrer">Open original</a><a href={document.textUrl} target="_blank" rel="noreferrer">Open text copy</a></span>}</div>
                  <button type="button" onClick={() => onDelete(document.id)}>Delete</button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function App() {
  const [view, setView] = useState<View>(() => {
    const value = window.location.hash.replace("#", "") as View;
    const session = loadAdminSession();
    if (value === "admin-login" || value === "admin-dashboard") return session ? "admin-dashboard" : "admin-login";
    return ["home", "about", "faculty", "curriculum", "research", "events"].includes(value) ? value : "home";
  });
  const [adminSession, setAdminSession] = useState<AdminSession | null>(() => loadAdminSession());
  const [documents, setDocuments] = useState<PublishedDocument[]>(() => loadPublishedDocuments());
  const [inquiryOpen, setInquiryOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getBackendDocuments().then((backendDocuments) => {
      if (!cancelled && backendDocuments) {
        setDocuments(backendDocuments);
        persistDocuments(backendDocuments);
      }
    });
    void readStoredDocuments().then((storedDocuments) => {
      if (cancelled) return;
      if (storedDocuments.length === 0) {
        setDocuments((current) => {
          if (current.length > 0) persistDocuments(current);
          return current;
        });
        return;
      }
      setDocuments((current) => {
        const currentIds = new Set(current.map((document) => document.id));
        const merged = [...current, ...storedDocuments.filter((document) => !currentIds.has(document.id))];
        persistDocuments(merged);
        return merged;
      });
    }).catch(() => undefined);

    const handleHash = () => {
      const value = window.location.hash.replace("#", "") as View;
      if (value === "admin-login" || value === "admin-dashboard") {
        const session = loadAdminSession();
        setView(value === "admin-dashboard" && !session ? "admin-login" : value === "admin-login" && session ? "admin-dashboard" : value);
        return;
      }
      if (["home", "about", "faculty", "curriculum", "research", "events"].includes(value)) setView(value);
    };
    window.addEventListener("hashchange", handleHash);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", handleHash);
    };
  }, []);

  const navigate = (nextPage: Page) => {
    window.location.hash = nextPage;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const publishDocument = async (file: File, category: DocumentCategory, designation?: string) => {
    const converted = await convertUploadedFile(file);
    const session = adminSession ?? loadAdminSession();
    if (!session) throw new Error("Your admin session has expired. Please sign in again.");
    const sourceDataUrl = category === "faculty" && converted.type === "PDF" ? await fileToDataUrl(file) : undefined;
    const document: PublishedDocument = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      category,
      type: converted.type,
      html: converted.html,
      text: converted.text,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      uploadedBy: session.username,
      designation,
      sourceDataUrl,
    };
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", category);
      formData.append("type", converted.type);
      formData.append("html", converted.html);
      formData.append("text", converted.text);
      formData.append("uploadedBy", session.username);
      if (designation) formData.append("designation", designation);
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: { "x-admin-username": session.username, "x-admin-password": adminAccounts[session.username]?.password ?? "" },
        body: formData,
      });
      if (response.ok) {
        const savedDocument = await response.json() as PublishedDocument;
        setDocuments((current) => {
          const next = [savedDocument, ...current];
          persistDocuments(next);
          return next;
        });
        return;
      }
    } catch {
      // The browser copy below keeps the site usable when the API is not running.
    }
    setDocuments((current) => {
      const next = [document, ...current];
      persistDocuments(next);
      return next;
    });
  };

  const deleteDocument = (id: string) => {
    const session = adminSession ?? loadAdminSession();
    void fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: session ? { "x-admin-username": session.username, "x-admin-password": adminAccounts[session.username]?.password ?? "" } : undefined,
    }).catch(() => undefined);
    setDocuments((current) => {
      const next = current.filter((document) => document.id !== id);
      persistDocuments(next);
      return next;
    });
  };

  const pageContent = {
    home: <HomePage />,
    about: <AboutPage onApply={() => setInquiryOpen(true)} />,
    faculty: <FacultyPage documents={documents} />,
    curriculum: <CurriculumPage documents={documents} />,
    research: <ResearchPage documents={documents} />,
    events: <EventsPage documents={documents} />,
  }[view as Page];

  const openAdminArea = () => {
    window.location.hash = adminSession ? "admin-dashboard" : "admin-login";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (view === "admin-login") {
    return <div className="app app-admin"><AdminLoginPage onLogin={(session) => { setAdminSession(session); setView("admin-dashboard"); window.location.hash = "admin-dashboard"; }} /></div>;
  }

  if (view === "admin-dashboard") {
    if (!adminSession) {
      window.location.hash = "admin-login";
      return <div className="app app-admin"><AdminLoginPage onLogin={(session) => { setAdminSession(session); setView("admin-dashboard"); window.location.hash = "admin-dashboard"; }} /></div>;
    }
    return <div className="app app-admin"><AdminDashboardPage session={adminSession} documents={documents} onUpload={publishDocument} onDelete={deleteDocument} onLogout={() => { sessionStorage.removeItem(adminSessionKey); setAdminSession(null); setView("admin-login"); window.location.hash = "admin-login"; }} /></div>;
  }

  return (
    <div className={`app app-${view}`}>
      <Header current={view as Page} onNavigate={navigate} onInquire={() => setInquiryOpen(true)} />
      {pageContent}
      <Footer adminSession={adminSession} onAdminAccess={openAdminArea} />
      {inquiryOpen && <InquiryModal onClose={() => setInquiryOpen(false)} />}
    </div>
  );
}

export default App;
