import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const dataDirectory = path.join(__dirname, "data");
const documentDirectory = path.join(dataDirectory, "documents");
const metadataFile = path.join(dataDirectory, "documents.json");
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const admins = {
  mainadmin: { password: process.env.MAIN_ADMIN_PASSWORD || "biochem2026", role: "main" },
  deptadmin: { password: process.env.DEPT_ADMIN_PASSWORD || "biochem2026", role: "department" },
};

app.disable("x-powered-by");

function safeEqual(value, expected) {
  const a = Buffer.from(String(value ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAdmin(request) {
  const username = String(request.headers["x-admin-username"] || "").toLowerCase();
  const account = admins[username];
  if (!account) return false;
  const provided = String(request.headers["x-admin-password"] || "");
  return provided.length > 0 && safeEqual(provided, account.password);
}

const idPattern = /^[0-9a-z-]{8,64}$/i;

app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Username, X-Admin-Password");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (request.method === "OPTIONS") return response.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

async function readDocuments() {
  try {
    return JSON.parse(await fs.readFile(metadataFile, "utf8"));
  } catch {
    return [];
  }
}

async function writeDocuments(documents) {
  await fs.mkdir(documentDirectory, { recursive: true });
  const tempFile = `${metadataFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(documents, null, 2), "utf8");
  await fs.rename(tempFile, metadataFile);
}

function safeExtension(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return [".pdf", ".doc", ".docx"].includes(extension) ? extension : ".bin";
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "juw-biochemistry-api", time: new Date().toISOString() });
});

app.get("/api/documents", async (_request, response) => {
  response.json(await readDocuments());
});

app.post("/api/documents", upload.single("file"), async (request, response) => {
  if (!isAdmin(request)) return response.status(401).json({ error: "Admin access required." });
  if (!request.file) return response.status(400).json({ error: "A PDF or Word file is required." });

  const validCategories = new Set(["curriculum", "faculty", "research", "events"]);
  const category = validCategories.has(request.body.category) ? request.body.category : "curriculum";
  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const folder = path.join(documentDirectory, id);
  const extension = safeExtension(request.file.originalname);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, `source${extension}`), request.file.buffer);
  await fs.writeFile(path.join(folder, "content.txt"), String(request.body.text || ""), "utf8");

  const document = {
    id,
    name: request.file.originalname,
    category,
    type: String(request.body.type || extension.slice(1).toUpperCase()),
    html: String(request.body.html || ""),
    text: String(request.body.text || ""),
    size: request.file.size,
    uploadedAt: new Date().toISOString(),
    uploadedBy: String(request.body.uploadedBy || request.headers["x-admin-username"] || "admin"),
    designation: category === "faculty" ? String(request.body.designation || "Lecturer") : undefined,
    fileUrl: `/api/documents/${id}/file`,
    textUrl: `/api/documents/${id}/text`,
  };
  const documents = await readDocuments();
  documents.unshift(document);
  await writeDocuments(documents);
  return response.status(201).json(document);
});

app.get("/api/documents/:id/file", async (request, response) => {
  if (!idPattern.test(request.params.id)) return response.sendStatus(400);
  const document = (await readDocuments()).find((item) => item.id === request.params.id);
  if (!document) return response.sendStatus(404);
  const extension = safeExtension(document.name);
  const filePath = path.join(documentDirectory, document.id, `source${extension}`);
  try {
    response.type(extension === ".pdf" ? "application/pdf" : extension === ".docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/msword");
    response.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(document.name)}"`);
    return response.sendFile(filePath);
  } catch {
    return response.sendStatus(404);
  }
});

app.get("/api/documents/:id/text", async (request, response) => {
  if (!idPattern.test(request.params.id)) return response.sendStatus(400);
  const document = (await readDocuments()).find((item) => item.id === request.params.id);
  if (!document) return response.sendStatus(404);
  try {
    response.type("text/plain");
    return response.sendFile(path.join(documentDirectory, document.id, "content.txt"));
  } catch {
    return response.sendStatus(404);
  }
});

app.delete("/api/documents/:id", async (request, response) => {
  if (!idPattern.test(request.params.id)) return response.sendStatus(400);
  if (!isAdmin(request)) return response.status(401).json({ error: "Admin access required." });
  const documents = await readDocuments();
  const document = documents.find((item) => item.id === request.params.id);
  if (!document) return response.sendStatus(404);
  await fs.rm(path.join(documentDirectory, document.id), { recursive: true, force: true });
  await writeDocuments(documents.filter((item) => item.id !== document.id));
  return response.sendStatus(204);
});

app.use(express.static(path.join(__dirname, "dist"), { maxAge: "1h", etag: true }));
app.use((_request, response) => response.sendFile(path.join(__dirname, "dist", "index.html")));

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: `Upload rejected (${error.code}).` });
  }
  console.error(error);
  response.status(500).json({ error: "Something went wrong while processing the request." });
});

await fs.mkdir(documentDirectory, { recursive: true });
app.listen(port, () => {
  console.log(`JUW Biochemistry website (production) running at http://localhost:${port}`);
  console.log(`Uploaded documents are stored permanently in ${documentDirectory}`);
});
