import { redirect } from 'next/navigation'

// Middleware sends / to /dashboard or /login; this is only a fallback.
const Home = () => redirect('/dashboard')

export default Home
