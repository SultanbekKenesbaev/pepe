import type { Express } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { DB } from './db.js';
import { uid, hashToken, passwordMatches, passwordHash, passwordValid, validTotp, newTotp, publicUser, ApiError } from './security.js';
import { parse } from './validation.js';
import { tenant } from './access.js';

export function installAuth(app:Express,db:DB,ctx:any) {
  const cookieName='ai_teacher_session';
  const cookieOptions={httpOnly:true,secure:ctx.production,sameSite:'strict' as const,path:'/',maxAge:12*60*60*1000};
  const loginLimit=rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Слишком много попыток входа. Повторите позже.',code:'RATE_LIMITED'}});
  app.post('/api/auth/login',loginLimit,async(req:any,res)=>{
    const input=parse<any>(z.object({email:z.string().email().max(254),password:z.string().max(200),totp:z.string().max(10).optional()}),req.body);
    const row=(await db.query('SELECT * FROM users WHERE email=$1',[input.email.toLowerCase()])).rows[0];
    if(!passwordMatches(input.password,row?.password_hash)||!row?.data.active||!['ADMIN','TEACHER'].includes(row?.data.role))throw new ApiError(401,'Неверный email или пароль','INVALID_CREDENTIALS');
    if(row.mfa_secret&&!validTotp(row.mfa_secret,input.totp,row.email))throw new ApiError(401,'Введите действующий код двухфакторной аутентификации','MFA_REQUIRED');
    const token=uid()+uid(), csrf=uid()+uid();
    await db.query('INSERT INTO auth_sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,$4)',[hashToken(token),row.id,csrf,new Date(Date.now()+12*60*60*1000).toISOString()]);
    res.cookie(cookieName,token,cookieOptions);
    const user=publicUser(row); await ctx.audit(user,'auth.login',user.id);
    res.json(await ctx.bootstrap(user,csrf));
  });
  app.use('/api',async(req:any,_res,next)=>{
    const token=req.cookies[cookieName];
    if(!token||typeof token!=='string')throw new ApiError(401,'Войдите в систему','UNAUTHENTICATED');
    const result=await db.query('SELECT u.*,s.csrf,s.token_hash,s.pending_mfa FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()',[hashToken(token)]);
    const row=result.rows[0];
    if(!row||!row.data.active||!['ADMIN','TEACHER'].includes(row.data.role))throw new ApiError(401,'Сессия истекла. Войдите снова.','UNAUTHENTICATED');
    req.user=publicUser(row); req.auth=row;
    if(!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin=req.get('origin');
      if(origin) {
        let same=false; try{same=new URL(origin).host===req.get('host');}catch{}
        if(!same)throw new ApiError(403,'Запрос с другого сайта запрещён','CSRF');
      }
      if(req.get('X-CSRF-Token')!==row.csrf)throw new ApiError(403,'Недействительный защитный токен. Обновите страницу.','CSRF');
    }
    next();
  });
  app.get('/api/auth/me',async(req:any,res)=>res.json(await ctx.bootstrap(req.user,req.auth.csrf)));
  app.post('/api/auth/logout',async(req:any,res)=>{
    await db.query('DELETE FROM auth_sessions WHERE token_hash=$1',[req.auth.token_hash]);
    res.clearCookie(cookieName,{path:'/'}); res.json({ok:true});
  });
  app.post('/api/auth/password',async(req:any,res)=>{
    const {currentPassword,newPassword}=req.body||{};
    if(typeof currentPassword!=='string'||!passwordMatches(currentPassword,req.auth.password_hash))throw new ApiError(400,'Текущий пароль неверен');
    if(!passwordValid(newPassword))throw new ApiError(400,'Пароль: 10–200 символов, минимум одна буква и цифра');
    await db.transaction(async tx=>{
      await tx.query('UPDATE users SET password_hash=$1 WHERE id=$2',[passwordHash(newPassword),req.user.id]);
      await tx.query('DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash<>$2',[req.user.id,req.auth.token_hash]);
    });
    await ctx.audit(req.user,'auth.password.change',req.user.id); res.json({ok:true});
  });
  app.post('/api/auth/mfa/setup',async(req:any,res)=>{
    if(req.auth.mfa_secret)throw new ApiError(409,'Двухфакторная аутентификация уже включена');
    const result=newTotp(req.user.email);
    await db.query('UPDATE auth_sessions SET pending_mfa=$1 WHERE token_hash=$2',[result.secret,req.auth.token_hash]);
    res.json(result);
  });
  app.post('/api/auth/mfa/enable',async(req:any,res)=>{
    if(!validTotp(req.auth.pending_mfa,req.body?.code,req.user.email))throw new ApiError(400,'Неверный код подтверждения');
    await db.transaction(async tx=>{
      await tx.query('UPDATE users SET mfa_secret=$1 WHERE id=$2',[req.auth.pending_mfa,req.user.id]);
      await tx.query('UPDATE auth_sessions SET pending_mfa=NULL WHERE token_hash=$1',[req.auth.token_hash]);
      await tx.query('DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash<>$2',[req.user.id,req.auth.token_hash]);
    });
    await ctx.audit(req.user,'auth.mfa.enable',req.user.id); res.json({ok:true});
  });
  app.post('/api/auth/mfa/disable',async(req:any,res)=>{
    if(typeof req.body?.password!=='string'||!passwordMatches(req.body.password,req.auth.password_hash)||!validTotp(req.auth.mfa_secret,req.body.code,req.user.email))throw new ApiError(400,'Пароль или код подтверждения неверен');
    await db.query('UPDATE users SET mfa_secret=NULL WHERE id=$1',[req.user.id]);
    await ctx.audit(req.user,'auth.mfa.disable',req.user.id); res.json({ok:true});
  });
}
