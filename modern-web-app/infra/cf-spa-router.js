// CloudFront Function (viewer-request, default behavior only).
// Routes SPA deep links (/dashboard, /applications/APP-X1) to index.html
// without touching real assets or /api/* (which has its own behavior).
// Using a function instead of custom error responses keeps API error
// semantics intact — a 403 from the API stays a 403, never index.html.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.startsWith('/api/')) {
    return request;
  }

  // Anything without a file extension is a client-side route.
  if (!uri.includes('.')) {
    request.uri = '/index.html';
  }

  return request;
}
