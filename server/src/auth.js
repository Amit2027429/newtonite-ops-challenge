import jwt from 'jsonwebtoken';

export function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be configured in production');
  }
  return 'local-demo-secret-change-me';
}

export function authRequired(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return res.status(401).json({ error: 'Authentication required' });

  try {
    const claims = jwt.verify(match[1], jwtSecret());
    if (typeof claims.sub !== 'string' || !/^\d+$/.test(claims.sub)) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.user = { id: claims.sub };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
