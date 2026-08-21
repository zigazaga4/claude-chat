import LoginForm from '@/components/LoginForm';
import { isPasswordConfigured } from '@/server/auth';

// Read at request time, never prerendered — whether a password exists is an
// environment fact, and baking it in at build time would be wrong the moment
// .env.local changes.
export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <div className="h-full overflow-y-auto px-safe pb-safe pt-safe">
      <LoginForm configured={isPasswordConfigured()} />
    </div>
  );
}
