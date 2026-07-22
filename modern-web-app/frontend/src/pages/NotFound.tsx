import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="text-6xl font-extrabold text-pine-200 dark:text-pine-800">404</p>
      <h1 className="mt-4 font-display text-xl font-bold text-pine-950 dark:text-pine-100">That trail doesn't exist</h1>
      <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">The page you're looking for isn't on this mountain.</p>
      <Link to="/" className="mt-6 inline-block rounded-lg bg-pine-800 px-4 py-2 text-sm font-bold text-white hover:bg-pine-700">
        Back to base camp
      </Link>
    </div>
  );
}
