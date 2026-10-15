'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { KeyRound, LogIn } from 'lucide-react';
import { Problem } from '@/components/ui.js';
import { signIn } from './actions.js';

// `localSignIn` is given only by `npm run dev`: the details are shown and filled in.
export default function LoginForm({ localSignIn }) {
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <form action={action}>
      <div>
        <div className="eyebrow">Staff only</div>
        <h1>Sign in</h1>
      </div>
      {localSignIn && (
        <div className="credentials" role="note">
          <div className="credentials-head"><KeyRound aria-hidden="true" /> Local sign-in</div>
          <dl>
            <div><dt>Email</dt><dd className="mono">{localSignIn.email}</dd></div>
            <div><dt>Password</dt><dd className="mono">{localSignIn.password}</dd></div>
          </dl>
          <p>Shown only while the site runs with npm run dev. The deployed site never shows them.</p>
        </div>
      )}
      {state?.error && <Problem title="Not signed in" message={state.error} />}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" className="input" type="email" name="email" autoComplete="username" required defaultValue={state?.email || localSignIn?.email || ''} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" className="input" type="password" name="password" autoComplete="current-password" required defaultValue={localSignIn?.password || ''} />
      </div>
      <button className="btn btn-block" type="submit" disabled={pending}>
        <LogIn aria-hidden="true" /> {pending ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>
        A customer? <Link className="row-link" href="/support">Talk to our AI service assistant</Link>
      </p>
    </form>
  );
}
