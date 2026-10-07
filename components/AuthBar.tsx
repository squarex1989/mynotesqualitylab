'use client';

import { signIn, signOut, type AuthState } from '@/lib/auth';

/** 右上角：登录了显示头像和名字 + 退出；游客显示「Sign in with Google」 */
export function AuthBar({ auth, compact = false }: { auth: AuthState; compact?: boolean }) {
  if (auth.loading) return null;
  if (!auth.user) {
    if (!auth.configured) return null;
    return (
      <button className={compact ? 'small' : ''} onClick={signIn}>
        Sign in with Google
      </button>
    );
  }
  return (
    <div className="row" style={{ gap: 8 }}>
      {auth.user.picture && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={auth.user.picture} alt="" width={26} height={26} style={{ borderRadius: '50%' }} referrerPolicy="no-referrer" />
      )}
      {!compact && <span className="tiny">{auth.user.name || auth.user.email}</span>}
      <button className="small ghost" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}
