require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const { Readable } = require('node:stream');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const { initializeDatabase, get, all, run, isRemoteDatabase } = require('./db');
const DatabaseSessionStore = require('./db-session-store');

const app = express();
const port = process.env.PORT || 3000;
const isVercel = process.env.VERCEL === '1';

if (isVercel && !process.env.SESSION_SECRET) {
  throw new Error('Configure SESSION_SECRET for Vercel deployments.');
}

app.set('trust proxy', isVercel ? 1 : false);

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Express 4 does not forward rejected promises from async route handlers.
for (const method of ['get', 'post']) {
  const registerRoute = app[method].bind(app);
  app[method] = (...args) => {
    if (args.length < 2) {
      return registerRoute(...args);
    }

    return registerRoute(args[0], ...args.slice(1).map((handler) => (
      typeof handler === 'function' && handler.constructor.name === 'AsyncFunction'
        ? asyncHandler(handler)
        : handler
    )));
  };
}

let databaseInitialization;
function ensureDatabaseInitialized() {
  if (!databaseInitialization) {
    databaseInitialization = initializeDatabase();
  }
  return databaseInitialization;
}

const storage = isVercel
  ? multer.memoryStorage()
  : multer.diskStorage({
    destination: function destination(req, file, cb) {
      cb(null, path.join(__dirname, 'public', 'uploads'));
    },
    filename: function filename(req, file, cb) {
      const safeName = path.basename(file.originalname).replace(/[^\w.-]+/g, '-');
      const unique = crypto.randomBytes(6).toString('hex');
      cb(null, `${unique}-${safeName}`);
    },
  });

const upload = multer({
  storage,
  limits: {
    fileSize: isVercel ? 4 * 1024 * 1024 : 5 * 1024 * 1024,
  },
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(asyncHandler(async (req, res, next) => {
  await ensureDatabaseInitialized();
  next();
}));

const sessionOptions = {
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isVercel,
    maxAge: 1000 * 60 * 60 * 8,
  },
};

if (isRemoteDatabase) {
  sessionOptions.store = new DatabaseSessionStore();
}

app.use(session({
  ...sessionOptions,
}));

function formatDate(value) {
  if (!value) return 'TBD';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

async function getSiteSettings() {
  const rows = await all('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

async function loadSiteContext(req, res, next) {
  const settings = await getSiteSettings();
  res.locals.settings = settings;
  res.locals.user = req.session.user || null;
  res.locals.formatDate = formatDate;
  next();
}

app.use(asyncHandler(loadSiteContext));

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).render('error', {
        title: 'Access denied',
        message: `This page is restricted to ${role} users.`,
      });
    }
    next();
  };
}

async function getDashboardStats() {
  const [totalCourses, totalDepartments, totalFaculty, totalStudents, pendingApplications, upcomingEvents, unreadInquiries] = await Promise.all([
    get('SELECT COUNT(*) AS value FROM courses WHERE published = 1'),
    get('SELECT COUNT(*) AS value FROM departments WHERE published = 1'),
    get('SELECT COUNT(*) AS value FROM faculty WHERE published = 1'),
    get('SELECT COUNT(*) AS value FROM users WHERE role = "student"'),
    get('SELECT COUNT(*) AS value FROM applications WHERE status IN ("Submitted", "Under Review", "Additional Information Required")'),
    get('SELECT COUNT(*) AS value FROM events WHERE published = 1 AND event_date >= date("now")'),
    get('SELECT COUNT(*) AS value FROM inquiries WHERE status = "New"'),
  ]);

  return {
    totalCourses: totalCourses.value,
    totalDepartments: totalDepartments.value,
    totalFaculty: totalFaculty.value,
    totalStudents: totalStudents.value,
    pendingApplications: pendingApplications.value,
    upcomingEvents: upcomingEvents.value,
    unreadInquiries: unreadInquiries.value,
  };
}

app.get('/', async (req, res) => {
  const [departments, courses, announcements, events, faculty] = await Promise.all([
    all('SELECT * FROM departments WHERE published = 1 ORDER BY id LIMIT 3'),
    all('SELECT c.*, d.name AS department_name FROM courses c JOIN departments d ON d.id = c.department_id WHERE c.published = 1 ORDER BY c.id LIMIT 3'),
    all('SELECT * FROM announcements WHERE published = 1 ORDER BY published_at DESC LIMIT 3'),
    all('SELECT * FROM events WHERE published = 1 ORDER BY event_date ASC LIMIT 3'),
    all('SELECT * FROM faculty WHERE published = 1 ORDER BY id LIMIT 3'),
  ]);

  res.render('home', {
    title: 'Home',
    departments,
    courses,
    announcements,
    events,
    faculty,
  });
});

app.get('/about', async (req, res) => {
  const [faculty, departments] = await Promise.all([
    all('SELECT * FROM faculty WHERE published = 1 ORDER BY id'),
    all('SELECT * FROM departments WHERE published = 1 ORDER BY id LIMIT 4'),
  ]);

  res.render('about', {
    title: 'About Us',
    faculty,
    departments,
  });
});

app.get('/departments', async (req, res) => {
  const departments = await all('SELECT * FROM departments WHERE published = 1 ORDER BY id');
  res.render('departments', { title: 'Departments', departments });
});

app.get('/departments/:slug', async (req, res) => {
  const department = await get('SELECT * FROM departments WHERE slug = ? AND published = 1', [req.params.slug]);
  if (!department) {
    return res.status(404).render('error', { title: 'Department not found', message: 'The requested department is not available.' });
  }
  const courses = await all('SELECT * FROM courses WHERE department_id = ? AND published = 1 ORDER BY id', [department.id]);
  res.render('department', { title: department.name, department, courses });
});

app.get('/courses', async (req, res) => {
  const { department, degree } = req.query;
  let sql = 'SELECT c.*, d.name AS department_name FROM courses c JOIN departments d ON d.id = c.department_id WHERE c.published = 1';
  const params = [];

  if (department) {
    sql += ' AND d.slug = ?';
    params.push(department);
  }

  if (degree) {
    sql += ' AND c.degree_type = ?';
    params.push(degree);
  }

  sql += ' ORDER BY c.id';

  const courses = await all(sql, params);
  const departments = await all('SELECT * FROM departments WHERE published = 1 ORDER BY id');
  res.render('courses', { title: 'Courses and Programs', courses, departments, selectedDepartment: department || '', selectedDegree: degree || '' });
});

app.get('/courses/:slug', async (req, res) => {
  const course = await get(`SELECT c.*, d.name AS department_name FROM courses c JOIN departments d ON d.id = c.department_id WHERE c.slug = ? AND c.published = 1`, [req.params.slug]);
  if (!course) {
    return res.status(404).render('error', { title: 'Course not found', message: 'The requested program could not be found.' });
  }
  const related = await all('SELECT * FROM courses WHERE department_id = ? AND published = 1 AND id != ? ORDER BY id LIMIT 3', [course.department_id, course.id]);
  res.render('course', { title: course.title, course, related });
});

app.get('/admissions', async (req, res) => {
  const announcements = await all('SELECT * FROM announcements WHERE published = 1 ORDER BY published_at DESC LIMIT 2');
  const departments = await all('SELECT * FROM departments WHERE published = 1 ORDER BY id');
  res.render('admissions', { title: 'Admissions', announcements, departments });
});

app.get('/admission-requirements', (req, res) => {
  res.render('admissions', { title: 'Admission Requirements' });
});

app.get('/apply', (req, res) => {
  res.render('apply', { title: 'Apply Now', success: '', error: '', formData: {} });
});

app.post('/apply', upload.single('supporting_document'), async (req, res) => {
  const {
    applicant_name,
    email,
    phone,
    dob,
    address,
    previous_qualification,
    previous_institution,
    marks,
    program_applied,
    academic_year,
    consent,
  } = req.body;

  if (!applicant_name || !email || !program_applied || !consent) {
    return res.status(400).render('apply', {
      title: 'Apply Now',
      success: '',
      error: 'Please complete the required fields and confirm the consent statement.',
      formData: req.body,
    });
  }

  const referenceNumber = `NWC-${Date.now()}`;
  let documentPath = null;
  if (req.file) {
    if (isVercel) {
      if (!process.env.BLOB_STORE_ID) {
        throw new Error('Connect a private Vercel Blob store before accepting application documents.');
      }
      const { put } = await import('@vercel/blob');
      const safeName = path.basename(req.file.originalname).replace(/[^\w.-]+/g, '-');
      const blob = await put(
        `applications/${crypto.randomUUID()}-${safeName}`,
        req.file.buffer,
        {
          access: 'private',
          contentType: req.file.mimetype,
          addRandomSuffix: false,
        },
      );
      documentPath = `blob:${blob.pathname}`;
    } else {
      documentPath = `/uploads/${req.file.filename}`;
    }
  }

  await run(`INSERT INTO applications (applicant_name, email, phone, dob, address, previous_qualification, previous_institution, marks, program_applied, academic_year, status, reference_number, document_path, consent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?)`, [
    applicant_name,
    email,
    phone,
    dob,
    address,
    previous_qualification,
    previous_institution,
    marks,
    program_applied,
    academic_year,
    referenceNumber,
    documentPath,
    Number(Boolean(consent)),
  ]);

  res.render('apply', {
    title: 'Apply Now',
    success: `Application submitted successfully. Your reference number is ${referenceNumber}.`,
    error: '',
    formData: {},
  });
});

app.get('/contact', (req, res) => {
  res.render('contact', { title: 'Contact Us', success: '', error: '' });
});

app.post('/contact', async (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).render('contact', {
      title: 'Contact Us',
      success: '',
      error: 'Name, email, and message are required.',
    });
  }

  await run('INSERT INTO inquiries (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)', [name, email, phone, subject, message]);
  res.render('contact', {
    title: 'Contact Us',
    success: 'Your message has been recorded successfully. Our team will contact you shortly.',
    error: '',
  });
});

app.get('/faq', (req, res) => {
  const faqs = [
    { question: 'Who can apply for admission?', answer: 'Prospective students seeking undergraduate and selected postgraduate programs can apply through the admissions portal.' },
    { question: 'Are applications reviewed manually?', answer: 'Yes. Every application is reviewed by the admissions and academic team according to program requirements.' },
    { question: 'Can I check my admission status online?', answer: 'Yes. After submission, applicants can review their application status through the secure admissions workflow.' },
  ];
  res.render('faq', { title: 'Frequently Asked Questions', faqs });
});

app.get('/privacy-policy', (req, res) => {
  res.render('privacy-policy', { title: 'Privacy Policy' });
});

app.get('/terms', (req, res) => {
  res.render('terms', { title: 'Terms and Conditions' });
});

app.get('/accessibility-statement', (req, res) => {
  res.render('accessibility-statement', { title: 'Accessibility Statement' });
});

app.get('/login', (req, res) => {
  res.render('login', { title: 'Login', error: '', next: req.query.next || '/dashboard' });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await get('SELECT * FROM users WHERE email = ?', [email]);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).render('login', {
      title: 'Login',
      error: 'Invalid email or password.',
      next: req.body.next || '/dashboard',
    });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    department_id: user.department_id,
  };

  res.redirect(req.body.next || '/dashboard');
});

app.get('/register', (req, res) => {
  res.render('register', { title: 'Register', error: '' });
});

app.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.status(400).render('register', { title: 'Register', error: 'Name, email, and password are required.' });
  }
  const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    return res.status(409).render('register', { title: 'Register', error: 'An account already exists for this email address.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  await run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)', [name, email, hash, role || 'student']);
  res.redirect('/login');
});

app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { title: 'Forgot Password', success: '', error: '' });
});

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = await get('SELECT id FROM users WHERE email = ?', [email]);
  if (!user) {
    return res.status(404).render('forgot-password', { title: 'Forgot Password', success: '', error: 'No account was found with that email address.' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  req.session.resetToken = token;
  req.session.resetEmail = email;

  res.render('forgot-password', {
    title: 'Forgot Password',
    success: `A password reset link is ready in the demo flow. Open /reset-password?token=${token}`,
    error: '',
  });
});

app.get('/reset-password', (req, res) => {
  const token = req.query.token || '';
  if (!token || token !== (req.session.resetToken || '')) {
    return res.status(400).render('error', { title: 'Reset Failed', message: 'The reset token is invalid or has expired.' });
  }
  res.render('reset-password', { title: 'Reset Password', error: '', token });
});

app.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || token !== (req.session.resetToken || '')) {
    return res.status(400).render('error', { title: 'Reset Failed', message: 'The reset token is invalid or has expired.' });
  }

  const user = await get('SELECT * FROM users WHERE email = ?', [req.session.resetEmail]);
  if (!user) {
    return res.status(400).render('error', { title: 'Reset Failed', message: 'The associated account no longer exists.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  await run('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);
  delete req.session.resetToken;
  delete req.session.resetEmail;

  res.redirect('/login');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/dashboard', requireAuth, async (req, res) => {
  if (req.session.user.role === 'admin') {
    return res.redirect('/admin-dashboard');
  }
  if (req.session.user.role === 'faculty') {
    return res.redirect('/faculty-dashboard');
  }
  return res.redirect('/student-dashboard');
});

app.get('/student-dashboard', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'student') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'This dashboard is only available to student accounts.' });
  }

  const [announcements, events, applications] = await Promise.all([
    all('SELECT * FROM announcements WHERE published = 1 ORDER BY published_at DESC LIMIT 3'),
    all('SELECT * FROM events WHERE published = 1 ORDER BY event_date ASC LIMIT 3'),
    all('SELECT * FROM applications WHERE email = ? ORDER BY created_at DESC LIMIT 5', [req.session.user.email]),
  ]);

  res.render('student-dashboard', { title: 'Student Dashboard', announcements, events, applications });
});

app.get('/faculty-dashboard', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'faculty') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'This dashboard is only available to faculty accounts.' });
  }

  const [announcements, courses, facultyRecord] = await Promise.all([
    all('SELECT * FROM announcements WHERE published = 1 ORDER BY published_at DESC LIMIT 3'),
    all('SELECT * FROM courses WHERE published = 1 ORDER BY id LIMIT 4'),
    get('SELECT * FROM faculty WHERE email = ?', [req.session.user.email]),
  ]);

  res.render('faculty-dashboard', { title: 'Faculty Dashboard', announcements, courses, facultyRecord });
});

app.get('/admin-dashboard', requireAuth, requireRole('admin'), async (req, res) => {
  const [stats, departments, courses, applications, inquiries] = await Promise.all([
    getDashboardStats(),
    all('SELECT * FROM departments WHERE published = 1 ORDER BY id'),
    all('SELECT c.*, d.name AS department_name FROM courses c JOIN departments d ON d.id = c.department_id WHERE c.published = 1 ORDER BY c.id LIMIT 6'),
    all('SELECT * FROM applications ORDER BY created_at DESC LIMIT 5'),
    all('SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 5'),
  ]);

  res.render('admin-dashboard', {
    title: 'Admin Dashboard',
    stats,
    departments,
    courses,
    applications,
    inquiries,
  });
});

app.get('/admin/applications', requireAuth, requireRole('admin'), async (req, res) => {
  const applications = await all('SELECT * FROM applications ORDER BY created_at DESC');
  res.render('admin-applications', { title: 'Admission Management', applications });
});

app.get('/admin/applications/:id/document', requireAuth, requireRole('admin'), async (req, res, next) => {
  const application = await get('SELECT document_path FROM applications WHERE id = ?', [req.params.id]);
  if (!application || !application.document_path) {
    return res.sendStatus(404);
  }

  if (application.document_path.startsWith('blob:')) {
    const { get: getBlob } = await import('@vercel/blob');
    const pathname = application.document_path.slice('blob:'.length);
    const blob = await getBlob(pathname, { access: 'private' });
    if (!blob || blob.statusCode !== 200) {
      return res.sendStatus(404);
    }

    res.setHeader('Content-Type', blob.blob.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.attachment(path.basename(pathname));
    return Readable.fromWeb(blob.stream).on('error', next).pipe(res);
  }

  if (!application.document_path.startsWith('/uploads/')) {
    return res.sendStatus(404);
  }
  return res.download(path.basename(application.document_path), {
    root: path.join(__dirname, 'public', 'uploads'),
  });
});

app.post('/admin/applications/:id/status', requireAuth, requireRole('admin'), async (req, res) => {
  const { status } = req.body;
  await run('UPDATE applications SET status = ? WHERE id = ?', [status, req.params.id]);
  res.redirect('/admin/applications');
});

app.get('/admin/courses', requireAuth, requireRole('admin'), async (req, res) => {
  const [courses, departments] = await Promise.all([
    all('SELECT c.*, d.name AS department_name FROM courses c JOIN departments d ON d.id = c.department_id ORDER BY c.id'),
    all('SELECT * FROM departments WHERE published = 1 ORDER BY id'),
  ]);
  res.render('admin-courses', { title: 'Course Management', courses, departments, success: '', error: '' });
});

app.post('/admin/courses', requireAuth, requireRole('admin'), async (req, res) => {
  const { department_id, title, slug, description, degree_type, duration, eligibility, admission_process, curriculum_url, image_url } = req.body;
  if (!title || !slug) {
    return res.status(400).render('admin-courses', { title: 'Course Management', success: '', error: 'Course title and slug are required.', courses: [], departments: await all('SELECT * FROM departments WHERE published = 1 ORDER BY id') });
  }

  await run(`INSERT INTO courses (department_id, title, slug, description, degree_type, duration, eligibility, admission_process, curriculum_url, image_url, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, [department_id, title, slug, description, degree_type, duration, eligibility, admission_process, curriculum_url, image_url]);

  res.redirect('/admin/courses');
});

app.get('/admin/departments', requireAuth, requireRole('admin'), async (req, res) => {
  const departments = await all('SELECT * FROM departments ORDER BY id');
  res.render('admin-departments', { title: 'Department Management', departments, success: '', error: '' });
});

app.post('/admin/departments', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, slug, description, head_name, contact_email, image_url } = req.body;
  if (!name || !slug) {
    return res.status(400).render('admin-departments', { title: 'Department Management', departments: await all('SELECT * FROM departments ORDER BY id'), success: '', error: 'Name and slug are required.' });
  }

  await run('INSERT INTO departments (name, slug, description, head_name, contact_email, image_url, published) VALUES (?, ?, ?, ?, ?, ?, 1)', [name, slug, description, head_name, contact_email, image_url]);
  res.redirect('/admin/departments');
});

app.get('/admin/events', requireAuth, requireRole('admin'), async (req, res) => {
  const events = await all('SELECT * FROM events ORDER BY event_date ASC');
  res.render('admin-events', { title: 'Event Management', events });
});

app.post('/admin/events', requireAuth, requireRole('admin'), async (req, res) => {
  const { title, slug, description, event_date, venue, image_url } = req.body;
  await run('INSERT INTO events (title, slug, description, event_date, venue, image_url, published) VALUES (?, ?, ?, ?, ?, ?, 1)', [title, slug, description, event_date, venue, image_url]);
  res.redirect('/admin/events');
});

app.get('/admin/announcements', requireAuth, requireRole('admin'), async (req, res) => {
  const announcements = await all('SELECT * FROM announcements ORDER BY published_at DESC');
  res.render('admin-announcements', { title: 'Announcement Management', announcements });
});

app.post('/admin/announcements', requireAuth, requireRole('admin'), async (req, res) => {
  const { title, slug, content, published_at, image_url } = req.body;
  await run('INSERT INTO announcements (title, slug, content, published_at, image_url, published) VALUES (?, ?, ?, ?, ?, 1)', [title, slug, content, published_at, image_url]);
  res.redirect('/admin/announcements');
});

app.get('/admin/inquiries', requireAuth, requireRole('admin'), async (req, res) => {
  const inquiries = await all('SELECT * FROM inquiries ORDER BY created_at DESC');
  res.render('admin-inquiries', { title: 'Inquiry Management', inquiries });
});

app.post('/admin/inquiries/:id/status', requireAuth, requireRole('admin'), async (req, res) => {
  const { status } = req.body;
  await run('UPDATE inquiries SET status = ? WHERE id = ?', [status, req.params.id]);
  res.redirect('/admin/inquiries');
});

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found',
    message: 'The page you requested is not available. Please return to the home page and continue browsing.',
  });
});

app.use((error, req, res, next) => {
  console.error(`Request failed for ${req.method} ${req.originalUrl}:`, error);
  if (res.headersSent) {
    return next(error);
  }

  const status = Number(error.status || error.statusCode);
  const responseStatus = status >= 400 && status < 600 ? status : 500;
  res.status(responseStatus).send('An unexpected error occurred. Please try again later.');
});

async function startServer() {
  await ensureDatabaseInitialized();
  app.listen(port, () => {
    console.log(`College website running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Unable to start the college website:', error);
    process.exit(1);
  });
}

module.exports = app;
