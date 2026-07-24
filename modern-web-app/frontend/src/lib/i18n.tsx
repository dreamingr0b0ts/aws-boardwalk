import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// Bilingual chrome for the citizen-facing portal (EN/ES). Coverage follows
// how Colorado civic sites actually ship: every public and resident surface
// is translated; the staff console and issued legal documents (certificate,
// decision letter) remain English. Records data (permit names, addresses,
// reviewer notes) is data, not chrome, and is shown as filed.

export type Lang = 'en' | 'es';

const STRINGS: Record<string, { en: string; es: string }> = {
  // --- shared chrome -------------------------------------------------------
  'banner.demo': {
    en: 'Fictional demonstration environment. The City of Alpenglow is not a real municipality. Demo data resets nightly.',
    es: 'Entorno ficticio de demostración. La Ciudad de Alpenglow no es un municipio real. Los datos se restablecen cada noche.',
  },
  'nav.permits': { en: 'Permits', es: 'Permisos' },
  'nav.transparency': { en: 'Transparency', es: 'Transparencia' },
  'nav.myApplications': { en: 'My applications', es: 'Mis solicitudes' },
  'nav.staff': { en: 'Staff', es: 'Personal' },
  'nav.signIn': { en: 'Sign in', es: 'Iniciar sesión' },
  'nav.signOut': { en: 'Sign out', es: 'Cerrar sesión' },
  'nav.resident': { en: 'Resident', es: 'Residente' },
  'nav.staffAdmin': { en: 'Staff · admin', es: 'Personal · admin' },
  'nav.themeToDark': { en: 'Switch to dark mode', es: 'Cambiar a modo oscuro' },
  'nav.themeToLight': { en: 'Switch to light mode', es: 'Cambiar a modo claro' },
  'nav.langLabel': { en: 'Cambiar a español', es: 'Switch to English' },
  'footer.counter': { en: 'Town Hall counter · Windows 01 to 05 · Elev 8,750 ft', es: 'Ventanillas 01 a 05 del Ayuntamiento · Elev 8,750 ft' },
  'footer.blurb': {
    en: 'A demonstration of a production-patterned serverless web application: static delivery, real authentication, role-based access, and a live data tier, idling at ~$0.',
    es: 'Una demostración de una aplicación web sin servidores con patrones de producción: entrega estática, autenticación real, acceso por roles y una capa de datos en vivo, con costo en reposo de ~$0.',
  },
  'footer.environment': { en: 'Environment', es: 'Entorno' },
  'footer.iac': { en: 'Infrastructure as code: Terraform', es: 'Infraestructura como código: Terraform' },
  'footer.reseeds': { en: 'Demo data reseeds nightly at 3am MT', es: 'Los datos de demostración se restablecen cada noche a las 3am MT' },
  'footer.photography': { en: 'Photography: Unsplash (Daniel Ribar, Alex Moliski, Royce Fonseca)', es: 'Fotografía: Unsplash (Daniel Ribar, Alex Moliski, Royce Fonseca)' },
  'footer.moreEnvs': { en: 'More live environments', es: 'Más entornos en vivo' },
  'footer.accessibility': { en: 'Accessibility', es: 'Accesibilidad' },
  'footer.fictional': {
    en: 'Fictional demo built by Planetek. Not affiliated with any real government agency.',
    es: 'Demostración ficticia creada por Planetek. Sin afiliación con ninguna agencia gubernamental real.',
  },
  'common.loading': { en: 'Loading…', es: 'Cargando…' },
  'common.backToDashboard': { en: '← Back to my applications', es: '← Volver a mis solicitudes' },

  // --- status + inspection stamps -----------------------------------------
  'status.submitted': { en: 'Submitted', es: 'Presentada' },
  'status.under_review': { en: 'Under review', es: 'En revisión' },
  'status.approved': { en: 'Approved', es: 'Aprobada' },
  'status.denied': { en: 'Denied', es: 'Denegada' },
  'insp.required': { en: 'Inspection due', es: 'Inspección pendiente' },
  'insp.scheduled': { en: 'Inspection scheduled', es: 'Inspección programada' },
  'insp.passed': { en: 'Finaled', es: 'Finalizado' },
  'insp.failed': { en: 'Reinspection required', es: 'Requiere reinspección' },

  // --- landing -------------------------------------------------------------
  'landing.eyebrow': { en: 'City of Alpenglow, Colorado', es: 'Ciudad de Alpenglow, Colorado' },
  'landing.h1a': { en: 'Permits,', es: 'Permisos,' },
  'landing.h1b': { en: 'without the line.', es: 'sin hacer fila.' },
  'landing.lede': {
    en: 'Apply for city permits online, track every application in real time, and see exactly how the permit office is performing, all in one place.',
    es: 'Solicite permisos municipales en línea, siga cada solicitud en tiempo real y vea el desempeño de la oficina de permisos, todo en un solo lugar.',
  },
  'landing.ctaApply': { en: 'Start an application', es: 'Iniciar una solicitud' },
  'landing.ctaBrowse': { en: 'Browse permit types', es: 'Ver tipos de permisos' },
  'landing.kpiProcessed': { en: 'Processed, 12 months', es: 'Procesadas, 12 meses' },
  'landing.kpiAvg': { en: 'Avg processing time', es: 'Tiempo promedio' },
  'landing.kpiOpen': { en: 'Open right now', es: 'Abiertas ahora' },
  'landing.days': { en: 'days', es: 'días' },
  'landing.window01': { en: 'Permit catalog', es: 'Catálogo de permisos' },
  'landing.catalogH2': { en: 'Everything the city issues', es: 'Todo lo que emite la ciudad' },
  'landing.catalogSub': {
    en: 'Fees and typical processing times are published for every permit the city issues.',
    es: 'Las tarifas y los plazos típicos están publicados para cada permiso que emite la ciudad.',
  },
  'landing.officePerf': { en: 'Office performance →', es: 'Desempeño de la oficina →' },
  'landing.apply': { en: 'Apply', es: 'Solicitar' },
  'landing.daysAbout': { en: 'days', es: 'días' },
  'landing.window02': { en: 'Transparency', es: 'Transparencia' },
  'landing.transpH2a': { en: 'The permit office', es: 'La oficina de permisos' },
  'landing.transpH2b': { en: 'shows its work.', es: 'muestra su trabajo.' },
  'landing.transpBody': {
    en: 'Every application in this demo feeds a live public dashboard: volumes, decisions, and how long each step really takes. No records request required.',
    es: 'Cada solicitud de esta demostración alimenta un panel público en vivo: volúmenes, decisiones y cuánto tarda realmente cada paso. Sin solicitudes de registros.',
  },
  'landing.transpCta': { en: 'See office performance →', es: 'Ver el desempeño de la oficina →' },
  'landing.window03': { en: 'Applications counter', es: 'Ventanilla de solicitudes' },
  'landing.howH2': { en: 'How it works', es: 'Cómo funciona' },
  'landing.how1t': { en: 'Create an account', es: 'Cree una cuenta' },
  'landing.how1b': {
    en: 'Sign up with your email, or use the demo accounts on the sign-in page to explore instantly.',
    es: 'Regístrese con su correo electrónico o use las cuentas de demostración de la página de inicio de sesión.',
  },
  'landing.how2t': { en: 'Submit your application', es: 'Presente su solicitud' },
  'landing.how2b': {
    en: 'Pick a permit type, describe the work, and submit. You get a tracking ID immediately.',
    es: 'Elija un tipo de permiso, describa la obra y envíe. Recibirá un número de seguimiento de inmediato.',
  },
  'landing.how3t': { en: 'Track to decision', es: 'Siga hasta la decisión' },
  'landing.how3b': {
    en: 'Watch status change from submitted to under review to decided, with reviewer notes at every step.',
    es: 'Vea el estado pasar de presentada a en revisión y a decidida, con notas del revisor en cada paso.',
  },

  // --- stats / transparency ------------------------------------------------
  'stats.window': { en: 'Records and performance', es: 'Registros y desempeño' },
  'stats.h1': { en: 'Permit office performance', es: 'Desempeño de la oficina de permisos' },
  'stats.sub': {
    en: 'Published live from the permit system, the same numbers staff see. Transparency is policy in Alpenglow.',
    es: 'Publicado en vivo desde el sistema de permisos, las mismas cifras que ve el personal. La transparencia es política en Alpenglow.',
  },
  'stats.kpiApps': { en: 'Applications, 12 months', es: 'Solicitudes, 12 meses' },
  'stats.kpiAppsSub': { en: 'all permit types', es: 'todos los tipos de permisos' },
  'stats.kpiRate': { en: 'Approval rate', es: 'Tasa de aprobación' },
  'stats.kpiRateSub': { en: 'of received, trailing 12 months', es: 'de las recibidas, últimos 12 meses' },
  'stats.kpiAvg': { en: 'Avg processing time', es: 'Tiempo promedio' },
  'stats.kpiAvgSub': { en: 'most recent month', es: 'mes más reciente' },
  'stats.kpiOpen': { en: 'Open right now', es: 'Abiertas ahora' },
  'stats.kpiOpenSub': { en: 'submitted or under review', es: 'presentadas o en revisión' },
  'stats.days': { en: 'days', es: 'días' },
  'stats.live': {
    en: 'Live from DynamoDB via the public API · reseeds nightly with the demo cycle',
    es: 'En vivo desde DynamoDB vía la API pública · se restablece cada noche con el ciclo de demostración',
  },
  'chart.monthlyTitle': { en: 'Applications by month', es: 'Solicitudes por mes' },
  'chart.monthlySub': { en: 'Trailing 12 months', es: 'Últimos 12 meses' },
  'chart.received': { en: 'Received', es: 'Recibidas' },
  'chart.approved': { en: 'Approved', es: 'Aprobadas' },
  'chart.typeTitle': { en: 'Volume by permit type', es: 'Volumen por tipo de permiso' },
  'chart.typeSub': { en: 'Trailing 12 months · single measure, one hue', es: 'Últimos 12 meses · una sola medida, un solo tono' },
  'chart.applications': { en: 'Applications', es: 'Solicitudes' },
  'chart.statusTitle': { en: 'Applications in the system', es: 'Solicitudes en el sistema' },
  'chart.statusSub': { en: 'total, by current status', es: 'en total, por estado actual' },

  // --- public register ------------------------------------------------------
  'register.title': { en: 'Register of decisions', es: 'Registro de decisiones' },
  'register.sub': {
    en: 'Every decided application, newest first. Open any line to verify it against the live register.',
    es: 'Cada solicitud decidida, primero las más recientes. Abra cualquier línea para verificarla contra el registro en vivo.',
  },
  'register.search': { en: 'Filter by number, type, or address', es: 'Filtrar por número, tipo o dirección' },
  'register.csv': { en: 'Download CSV', es: 'Descargar CSV' },
  'register.number': { en: 'Number', es: 'Número' },
  'register.type': { en: 'Type', es: 'Tipo' },
  'register.address': { en: 'Address', es: 'Dirección' },
  'register.decided': { en: 'Decided', es: 'Decidida' },
  'register.status': { en: 'Status', es: 'Estado' },
  'register.verify': { en: 'Verify', es: 'Verificar' },
  'register.empty': { en: 'No register lines match that filter.', es: 'Ninguna línea del registro coincide con ese filtro.' },

  // --- login / register ----------------------------------------------------
  'login.title': { en: 'Sign in', es: 'Iniciar sesión' },
  'login.portal': { en: 'Resident & staff portal', es: 'Portal de residentes y personal' },
  'login.email': { en: 'Email', es: 'Correo electrónico' },
  'login.password': { en: 'Password', es: 'Contraseña' },
  'login.submit': { en: 'Sign in', es: 'Iniciar sesión' },
  'login.busy': { en: 'Signing in…', es: 'Iniciando sesión…' },
  'login.newHere': { en: 'New here?', es: '¿Primera vez aquí?' },
  'login.create': { en: 'Create an account', es: 'Cree una cuenta' },
  'login.frontDesk': { en: 'Demo accounts', es: 'Cuentas de demostración' },
  'login.adminCard': { en: 'Staff admin', es: 'Personal administrador' },
  'login.adminDesc': { en: 'Review queue, decisions, metrics, catalog', es: 'Cola de revisión, decisiones, métricas, catálogo' },
  'login.citizenCard': { en: 'Resident', es: 'Residente' },
  'login.citizenDesc': { en: 'Submit and track applications', es: 'Presentar y seguir solicitudes' },
  'login.use': { en: 'Use', es: 'Usar' },
  'login.public': {
    en: 'These credentials are intentionally public. This is a portfolio demonstration. All accounts and data reset nightly at 3am Mountain.',
    es: 'Estas credenciales son públicas a propósito. Esta es una demostración de portafolio. Todas las cuentas y datos se restablecen cada noche a las 3am hora de la montaña.',
  },
  'reg.window': { en: 'New residents', es: 'Nuevos residentes' },
  'reg.h1': { en: 'Create a resident account', es: 'Crear una cuenta de residente' },
  'reg.intro1': {
    en: 'Real sign-up flow with email verification. Prefer not to? Use the',
    es: 'Registro real con verificación por correo. ¿Prefiere no hacerlo? Use las',
  },
  'reg.introLink': { en: 'demo accounts', es: 'cuentas de demostración' },
  'reg.name': { en: 'Full name', es: 'Nombre completo' },
  'reg.emailHint': { en: 'A verification code will be sent here.', es: 'Se enviará un código de verificación aquí.' },
  'reg.passwordHint': {
    en: '12+ characters with upper, lower, number, and symbol.',
    es: '12+ caracteres con mayúscula, minúscula, número y símbolo.',
  },
  'reg.submit': { en: 'Create account', es: 'Crear cuenta' },
  'reg.busy': { en: 'Creating…', es: 'Creando…' },
  'reg.sent': { en: 'We emailed a 6-digit code to', es: 'Enviamos un código de 6 dígitos a' },
  'reg.codeLabel': { en: 'Verification code', es: 'Código de verificación' },
  'reg.verify': { en: 'Verify & sign in', es: 'Verificar e iniciar sesión' },
  'reg.verifying': { en: 'Verifying…', es: 'Verificando…' },
  'reg.demoNote': {
    en: 'Demo environment: accounts created here are removed by the nightly reset.',
    es: 'Entorno de demostración: las cuentas creadas aquí se eliminan con el restablecimiento nocturno.',
  },
  'apply.descPlaceholder': {
    en: 'Tell the permit office about your project',
    es: 'Cuéntele a la oficina de permisos sobre su proyecto',
  },

  // --- dashboard -----------------------------------------------------------
  'dash.window': { en: 'My applications', es: 'Mis solicitudes' },
  'dash.h1': { en: 'My applications', es: 'Mis solicitudes' },
  'dash.signedInAs': { en: 'Signed in as', es: 'Sesión iniciada como' },
  'dash.new': { en: 'New application', es: 'Nueva solicitud' },
  'dash.kpiOpen': { en: 'Open', es: 'Abiertas' },
  'dash.kpiOpenSub': { en: 'submitted or under review', es: 'presentadas o en revisión' },
  'dash.kpiApproved': { en: 'Approved', es: 'Aprobadas' },
  'dash.kpiApprovedSub': { en: 'ready to post at the job site', es: 'listas para exhibir en la obra' },
  'dash.kpiDenied': { en: 'Denied', es: 'Denegadas' },
  'dash.kpiDeniedSub': { en: 'see the reviewer note for why', es: 'vea la nota del revisor' },
  'dash.loading': { en: 'Loading your applications…', es: 'Cargando sus solicitudes…' },
  'dash.emptyTitle': { en: 'No applications yet', es: 'Aún no hay solicitudes' },
  'dash.emptyCta': { en: 'Start your first application →', es: 'Inicie su primera solicitud →' },

  // --- apply wizard --------------------------------------------------------
  'apply.window': { en: 'Applications counter', es: 'Ventanilla de solicitudes' },
  'apply.h1': { en: 'New permit application', es: 'Nueva solicitud de permiso' },
  'apply.step1': { en: 'Permit type', es: 'Tipo de permiso' },
  'apply.step2': { en: 'Details', es: 'Detalles' },
  'apply.step3': { en: 'Review & submit', es: 'Revisar y enviar' },
  'apply.loadingTypes': { en: 'Loading permit types…', es: 'Cargando tipos de permisos…' },
  'apply.selected': { en: 'Selected', es: 'Seleccionado' },
  'apply.continue': { en: 'Continue', es: 'Continuar' },
  'apply.back': { en: 'Back', es: 'Atrás' },
  'apply.review': { en: 'Review', es: 'Revisar' },
  'apply.formB': { en: 'Form 03-B · Project details', es: 'Formulario 03-B · Detalles del proyecto' },
  'apply.formC': { en: 'Form 03-C · Review and submit', es: 'Formulario 03-C · Revisar y enviar' },
  'apply.address': { en: 'Project address', es: 'Dirección del proyecto' },
  'apply.addressHint': { en: 'Street address within Alpenglow city limits.', es: 'Dirección dentro de los límites de la ciudad de Alpenglow.' },
  'apply.describe': { en: 'Describe the work', es: 'Describa la obra' },
  'apply.chars': { en: 'characters (minimum 10)', es: 'caracteres (mínimo 10)' },
  'apply.reviewType': { en: 'Permit type', es: 'Tipo de permiso' },
  'apply.reviewCategory': { en: 'Category', es: 'Categoría' },
  'apply.reviewAddress': { en: 'Project address', es: 'Dirección del proyecto' },
  'apply.reviewDesc': { en: 'Description', es: 'Descripción' },
  'apply.reviewProcessing': { en: 'Typical processing', es: 'Plazo típico' },
  'apply.feeNoteA': { en: 'Permit fee:', es: 'Tarifa del permiso:' },
  'apply.feeNoteB': {
    en: ', due at issuance. (No payment is collected in this demo.)',
    es: ', pagadera al emitirse. (En esta demostración no se cobra ningún pago.)',
  },
  'apply.submit': { en: 'Submit application', es: 'Enviar solicitud' },
  'apply.submitting': { en: 'Submitting…', es: 'Enviando…' },
  'apply.days': { en: 'days', es: 'días' },
  'apply.doneTitle': { en: 'Application submitted', es: 'Solicitud enviada' },
  'apply.yourNumber': { en: 'Your number', es: 'Su número' },
  'apply.doneBody': {
    en: 'Keep it for your records. The permit office will begin review shortly.',
    es: 'Guárdelo para sus registros. La oficina de permisos comenzará la revisión en breve.',
  },
  'apply.track': { en: 'Track it', es: 'Seguirla' },
  'apply.myApps': { en: 'My applications', es: 'Mis solicitudes' },

  // --- application detail --------------------------------------------------
  'detail.window': { en: 'Application record', es: 'Expediente de la solicitud' },
  'detail.loading': { en: 'Loading application…', es: 'Cargando la solicitud…' },
  'detail.approvedBanner': { en: 'Permit approved', es: 'Permiso aprobado' },
  'detail.deniedBanner': { en: 'Application denied', es: 'Solicitud denegada' },
  'detail.viewCert': { en: 'View permit certificate', es: 'Ver certificado del permiso' },
  'detail.viewLetter': { en: 'View decision letter', es: 'Ver carta de decisión' },
  'detail.inspTitle': { en: 'Final inspection', es: 'Inspección final' },
  'detail.inspRequired': {
    en: 'The permit office will contact you to schedule the final inspection.',
    es: 'La oficina de permisos le contactará para programar la inspección final.',
  },
  'detail.inspScheduledFor': { en: 'Final inspection scheduled for', es: 'Inspección final programada para el' },
  'detail.inspScheduledTail': { en: 'Have the work site accessible.', es: 'Mantenga la obra accesible.' },
  'detail.inspScheduled': { en: 'Final inspection scheduled.', es: 'Inspección final programada.' },
  'detail.inspFailed': {
    en: "Correct the items in the inspector's note, then the office will schedule a reinspection.",
    es: 'Corrija los puntos de la nota del inspector; la oficina programará una reinspección.',
  },
  'detail.inspPassedA': { en: 'Final inspection passed', es: 'Inspección final aprobada' },
  'detail.inspPassedOn': { en: 'on', es: 'el' },
  'detail.inspPassedB': { en: 'The permit is closed out.', es: 'El permiso está finalizado.' },
  'detail.visit': { en: 'Visit', es: 'Visita' },
  'detail.details': { en: 'Application details', es: 'Detalles de la solicitud' },
  'detail.category': { en: 'Category', es: 'Categoría' },
  'detail.address': { en: 'Project address', es: 'Dirección del proyecto' },
  'detail.description': { en: 'Description', es: 'Descripción' },
  'detail.applicant': { en: 'Applicant', es: 'Solicitante' },
  'detail.submitted': { en: 'Submitted', es: 'Presentada' },
  'detail.actions': { en: 'Record of actions', es: 'Registro de acciones' },
  'detail.docsTitle': { en: 'Supporting documents', es: 'Documentos de apoyo' },
  'detail.docsRules': { en: 'PDF, PNG, or JPEG · up to 4 MB each · 3 per application', es: 'PDF, PNG o JPEG · hasta 4 MB cada uno · 3 por solicitud' },
  'detail.docsClosed': { en: ' · the file is closed to new documents once decided', es: ' · el expediente no admite documentos nuevos una vez decidido' },
  'detail.addDoc': { en: 'Add a document', es: 'Agregar un documento' },
  'detail.uploading': { en: 'Uploading…', es: 'Subiendo…' },
  'detail.docsLoading': { en: 'Loading documents…', es: 'Cargando documentos…' },
  'detail.docsEmptyOpen': {
    en: 'No documents on file yet. Site plans and drawings help the reviewer decide faster.',
    es: 'Aún no hay documentos en el expediente. Los planos ayudan al revisor a decidir más rápido.',
  },
  'detail.docsEmptyClosed': { en: 'No documents on file.', es: 'No hay documentos en el expediente.' },
  'detail.received': { en: 'received', es: 'recibido' },
  'detail.view': { en: 'View', es: 'Ver' },
  'detail.tooBig': { en: 'Documents can be up to 4 MB.', es: 'Los documentos pueden pesar hasta 4 MB.' },

  // --- bell ----------------------------------------------------------------
  'bell.label': { en: 'Notifications', es: 'Notificaciones' },
  'bell.header': { en: 'Counter bell', es: 'Campana de ventanilla' },
  'bell.markRead': { en: 'Mark all read', es: 'Marcar todo como leído' },
  'bell.empty': {
    en: 'No notices yet. Staff actions on your applications will ring here.',
    es: 'Aún no hay avisos. Las acciones del personal sobre sus solicitudes sonarán aquí.',
  },

  // --- verify --------------------------------------------------------------
  'verify.window': { en: 'Permit register', es: 'Registro de permisos' },
  'verify.h1': { en: 'Permit verification', es: 'Verificación de permiso' },
  'verify.sub': {
    en: 'Checked live against the same register the permit office uses. No account required.',
    es: 'Consultado en vivo contra el mismo registro que usa la oficina de permisos. No se requiere cuenta.',
  },
  'verify.checking': { en: 'Checking the register…', es: 'Consultando el registro…' },
  'verify.notFoundStamp': { en: 'Not on file', es: 'No consta' },
  'verify.failedStamp': { en: 'Check failed', es: 'Consulta fallida' },
  'verify.notFoundBody': { en: 'No permit or application numbered', es: 'Ningún permiso ni solicitud con el número' },
  'verify.notFoundTail': { en: 'exists in the Alpenglow register.', es: 'existe en el registro de Alpenglow.' },
  'verify.v.approved': { en: 'Valid permit', es: 'Permiso válido' },
  'verify.v.approvedBody': {
    en: 'This permit is on file and active in the City of Alpenglow permit register.',
    es: 'Este permiso consta y está activo en el registro de permisos de la Ciudad de Alpenglow.',
  },
  'verify.v.pending': { en: 'Pending: not issued', es: 'Pendiente: no emitido' },
  'verify.v.submittedBody': {
    en: 'An application with this number is on file but no permit has been issued. Work may not begin.',
    es: 'Existe una solicitud con este número pero no se ha emitido ningún permiso. La obra no puede comenzar.',
  },
  'verify.v.reviewBody': {
    en: 'An application with this number is under review. No permit has been issued and work may not begin.',
    es: 'Una solicitud con este número está en revisión. No se ha emitido ningún permiso y la obra no puede comenzar.',
  },
  'verify.v.denied': { en: 'No valid permit', es: 'Sin permiso válido' },
  'verify.v.deniedBody': {
    en: 'The application under this number was denied. No permit is in force at this address.',
    es: 'La solicitud con este número fue denegada. No hay permiso vigente en esta dirección.',
  },
  'verify.entry': { en: 'Register entry', es: 'Entrada del registro' },
  'verify.number': { en: 'Number', es: 'Número' },
  'verify.type': { en: 'Permit type', es: 'Tipo de permiso' },
  'verify.category': { en: 'Category', es: 'Categoría' },
  'verify.site': { en: 'Work site', es: 'Lugar de la obra' },
  'verify.holder': { en: 'Holder', es: 'Titular' },
  'verify.submitted': { en: 'Submitted', es: 'Presentada' },
  'verify.decided': { en: 'Decided', es: 'Decidida' },
  'verify.pending': { en: 'Pending', es: 'Pendiente' },
  'verify.status': { en: 'Status', es: 'Estado' },
  'verify.inspection': { en: 'Final inspection', es: 'Inspección final' },
  'verify.closedOut': { en: 'closed out', es: 'finalizado el' },
  'verify.checkedAt': { en: 'Checked against the live register', es: 'Consultado contra el registro en vivo' },
  'verify.haveNumber': { en: 'Have a permit number to check?', es: '¿Tiene un número de permiso para consultar?' },
  'verify.learn': { en: 'Learn about Alpenglow permits →', es: 'Conozca los permisos de Alpenglow →' },

  // --- accessibility statement ---------------------------------------------
  'a11y.title': { en: 'Accessibility', es: 'Accesibilidad' },
  'a11y.h1': { en: 'Accessibility statement', es: 'Declaración de accesibilidad' },
  'a11y.intro': {
    en: 'Alpenglow Permits is designed to conform to the Web Content Accessibility Guidelines (WCAG) 2.1 Level AA, the standard Colorado state law (HB21-1110) sets for government web services.',
    es: 'Alpenglow Permits está diseñado para cumplir con las Pautas de Accesibilidad para el Contenido Web (WCAG) 2.1 Nivel AA, el estándar que la ley de Colorado (HB21-1110) establece para los servicios web gubernamentales.',
  },
  'a11y.measuresH': { en: 'What that means here', es: 'Qué significa aquí' },
  'a11y.m1': { en: 'Every interactive control is reachable and operable by keyboard.', es: 'Cada control interactivo es accesible y operable con el teclado.' },
  'a11y.m2': { en: 'Text and interface colors meet AA contrast in both light and dark modes, and chart palettes are validated for color-vision deficiencies.', es: 'Los colores de texto e interfaz cumplen el contraste AA en modo claro y oscuro, y las paletas de las gráficas están validadas para deficiencias de visión cromática.' },
  'a11y.m3': { en: 'Status is never conveyed by color alone: stamps carry text, charts carry labeled rows, and notifications carry titles.', es: 'El estado nunca se comunica solo con color: los sellos llevan texto, las gráficas llevan filas etiquetadas y las notificaciones llevan títulos.' },
  'a11y.m4': { en: 'Pages carry a logical heading structure, landmarks, and descriptive link text; images that convey nothing are hidden from assistive technology.', es: 'Las páginas tienen una estructura lógica de encabezados, puntos de referencia y enlaces descriptivos; las imágenes decorativas están ocultas para la tecnología de asistencia.' },
  'a11y.m5': { en: 'The interface is available in English and Spanish; the language switch is in the header.', es: 'La interfaz está disponible en inglés y español; el cambio de idioma está en el encabezado.' },
  'a11y.testingH': { en: 'How it is tested', es: 'Cómo se prueba' },
  'a11y.testing': {
    en: 'Automated axe-core audits run against every page as part of the quality pipeline, alongside manual keyboard and screen-reader spot checks. Automated testing cannot catch everything; feedback matters.',
    es: 'Auditorías automatizadas con axe-core se ejecutan sobre cada página como parte del control de calidad, junto con revisiones manuales de teclado y lector de pantalla. Las pruebas automatizadas no lo detectan todo; sus comentarios importan.',
  },
  'a11y.feedbackH': { en: 'Feedback', es: 'Comentarios' },
  'a11y.feedback': {
    en: 'If any part of this demonstration is hard to use with assistive technology, write to info@planetek.org and it will be addressed.',
    es: 'Si alguna parte de esta demostración es difícil de usar con tecnología de asistencia, escriba a info@planetek.org y se atenderá.',
  },
  'a11y.note': {
    en: 'The permit certificate and decision letter are issued as English-language documents, matching how the fictional city files them.',
    es: 'El certificado del permiso y la carta de decisión se emiten como documentos en inglés, tal como los archiva la ciudad ficticia.',
  },

  // --- 404 ------------------------------------------------------------------
  'nf.title': { en: "That trail doesn't exist", es: 'Ese sendero no existe' },
  'nf.body': { en: "The page you're looking for isn't on this mountain.", es: 'La página que busca no está en esta montaña.' },
  'nf.cta': { en: 'Back to base camp', es: 'Volver al campamento base' },
};

interface LangContextValue {
  lang: Lang;
  toggle: () => void;
  t: (key: string) => string;
}

const LangContext = createContext<LangContextValue>({ lang: 'en', toggle: () => undefined, t: (k) => k });

/** Module-level date locale so fmtDate (a plain function) tracks the toggle. */
export let dateLocale = 'en-US';

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    try {
      const stored = localStorage.getItem('lang');
      return stored === 'es' ? 'es' : 'en';
    } catch {
      return 'en';
    }
  });

  useEffect(() => {
    document.documentElement.lang = lang;
    dateLocale = lang === 'es' ? 'es-US' : 'en-US';
  }, [lang]);

  const toggle = useCallback(() => {
    setLang((prev) => {
      const next: Lang = prev === 'en' ? 'es' : 'en';
      try {
        localStorage.setItem('lang', next);
      } catch {
        /* storage disabled */
      }
      return next;
    });
  }, []);

  const t = useCallback((key: string) => STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key, [lang]);

  return <LangContext.Provider value={{ lang, toggle, t }}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  return useContext(LangContext);
}
