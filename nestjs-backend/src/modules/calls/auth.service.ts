import { Injectable } from '@nestjs/common';

// Resolves a client-supplied auth token to a stable, trusted user id.
//
// INTEGRATION POINT: replace the body of `verifyToken` with your existing
// app's real authentication (verify the JWT your Flutter app already sends,
// look up a session, call your existing auth service, etc). The gateway
// never trusts a client-supplied user id directly -- every user identity
// used for call routing comes from whatever this method resolves the token
// to, never from the message payload.
//
// As a placeholder (so this module is runnable/testable standalone), this
// trusts the raw token value as the user id.
@Injectable()
export class AuthService {
  async verifyToken(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    return token;
  }
}
