import type { DB } from './db.js';
import { now } from './security.js';
import { localDate } from './university.js';

export async function migrateUniversity(db:DB,demo:boolean){
  await db.transaction(async tx=>{
    const statements=[
      'CREATE TABLE IF NOT EXISTS semesters(id TEXT PRIMARY KEY,institution_id TEXT NOT NULL REFERENCES institutions(id),teacher_id TEXT NOT NULL REFERENCES users(id),archived BOOLEAN NOT NULL DEFAULT FALSE,data JSONB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS semesters_scope ON semesters(institution_id,teacher_id)',
      'CREATE TABLE IF NOT EXISTS teaching_sessions(id TEXT PRIMARY KEY,institution_id TEXT NOT NULL REFERENCES institutions(id),event_id TEXT NOT NULL,teacher_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL,data JSONB NOT NULL)',
      "CREATE UNIQUE INDEX IF NOT EXISTS teaching_sessions_active_event ON teaching_sessions(institution_id,event_id) WHERE data->>'state'<>'completed'",
      'CREATE TABLE IF NOT EXISTS face_enrollments(student_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,institution_id TEXT NOT NULL REFERENCES institutions(id),data JSONB NOT NULL)',
      'CREATE TABLE IF NOT EXISTS lesson_materials(id TEXT PRIMARY KEY,institution_id TEXT NOT NULL REFERENCES institutions(id),teacher_id TEXT NOT NULL REFERENCES users(id),subject_id TEXT NOT NULL REFERENCES entities(id),data JSONB NOT NULL)',
      'CREATE INDEX IF NOT EXISTS lesson_materials_scope ON lesson_materials(institution_id,teacher_id)',
      "CREATE INDEX IF NOT EXISTS teaching_sessions_dates ON teaching_sessions(institution_id, (data->'event'->>'date'),teacher_id)",
    ];for(const statement of statements)await tx.query(statement);
    let institutions=(await tx.query('SELECT id,data FROM institutions ORDER BY id')).rows;
    if(!institutions.length&&(await tx.query('SELECT id FROM users LIMIT 1')).rows.length){const data={id:'university-primary',name:'Университет',type:'UNIVERSITY',language:'ru',settings:{timezone:'Asia/Tashkent',allowExternalAI:false,retentionDays:365},createdAt:now()};await tx.query('INSERT INTO institutions(id,data) VALUES($1,$2)',[data.id,data]);institutions=[{id:data.id,data}];}
    const primary=institutions.find(i=>i.id==='demo-school')?.id||institutions[0]?.id;
    for(const row of institutions){if(row.data.type!=='UNIVERSITY'){row.data.type='UNIVERSITY';await tx.query('UPDATE institutions SET data=$1 WHERE id=$2',[row.data,row.id]);}}
    const users=(await tx.query('SELECT * FROM users')).rows;
    for(const row of users){
      const data={...row.data};let institutionId=row.institution_id;
      if(data.role==='SUPER_ADMIN'){data.role='ADMIN';institutionId=institutionId||primary;data.institutionId=institutionId;}
      if(!['ADMIN','TEACHER'].includes(data.role))data.active=false;
      if(data.role==='ADMIN'&&!institutionId){institutionId=primary;data.institutionId=primary;}
      if(JSON.stringify(data)!==JSON.stringify(row.data)||institutionId!==row.institution_id){await tx.query('UPDATE users SET data=$1,institution_id=$2 WHERE id=$3',[data,institutionId,row.id]);await tx.query('DELETE FROM auth_sessions WHERE user_id=$1',[row.id]);}
    }
    if(!(await tx.query('SELECT version FROM schema_migrations WHERE version=3')).rows.length){
      if((await tx.query("SELECT id FROM institutions WHERE id='demo-school'")).rows.length){
        const inst=(await tx.query("SELECT data FROM institutions WHERE id='demo-school'")).rows[0].data;inst.name='Технический университет';inst.type='UNIVERSITY';inst.settings={...inst.settings,timezone:'Asia/Tashkent',modules:['semesterImport','cameraAttendance']};await tx.query("UPDATE institutions SET data=$1 WHERE id='demo-school'",[inst]);
        const updates:Record<string,any>={
          'demo-group-7a':{name:'ИС-21',level:'2 курс'},'demo-group-7b':{name:'ИС-22',level:'2 курс'},
          'demo-science':{name:'Факультет информационных технологий'},
          'demo-biology':{name:'Математический анализ',description:'Пределы, производные и интегралы.'},
          'demo-math':{name:'Алгоритмы и структуры данных',description:'Алгоритмы, их сложность и реализация.'},
          'demo-material-1':{name:'Производная функции',topic:'Производная',ageLevel:'2 курс',content:'Производная функции в точке — предел отношения приращения функции к приращению аргумента при стремлении последнего к нулю, если этот предел существует. Геометрический смысл — угловой коэффициент касательной к графику. Физический смысл производной координаты по времени — мгновенная скорость. Для f(x)=x² имеем f′(x)=2x. Производная суммы равна сумме производных; для произведения (uv)′=u′v+uv′.'},
          'demo-material-2':{name:'Правила дифференцирования',topic:'Дифференцирование',ageLevel:'2 курс',content:'Если функции u и v дифференцируемы, то (u+v)′=u′+v′ и (uv)′=u′v+uv′. При v≠0 производная частного (u/v)′=(u′v−uv′)/v². Для композиции f(g(x)) производная равна f′(g(x))·g′(x). Например, производная sin(x²) равна cos(x²)·2x.'},
          'demo-photosynthesis':{name:'Производная: смысл и правила',description:'Геометрический смысл производной и правила дифференцирования.',duration:90,quiz:[],sections:[
            {id:'definition',title:'Определение производной',content:'Рассмотрим отношение приращения функции к приращению аргумента: Δy/Δx.\n\nЕсли при Δx→0 это отношение имеет конечный предел, функция дифференцируема в данной точке. Этот предел называют производной f′(x).',materialIds:['demo-material-1']},
            {id:'meaning',title:'Геометрический и физический смысл',content:'Геометрически производная задаёт угловой коэффициент касательной к графику функции.\n\nЕсли s(t) — координата тела, то s′(t) — его мгновенная скорость. При s(t)=t² скорость равна 2t.',materialIds:['demo-material-1']},
            {id:'rules',title:'Правила дифференцирования',content:'Производная суммы равна сумме производных. Правило произведения: (uv)′=u′v+uv′.\n\nДля сложной функции: (f(g(x)))′=f′(g(x))·g′(x). Поэтому (sin(x²))′=2x·cos(x²).',materialIds:['demo-material-2']},
            {id:'examples',title:'Разбор примеров',content:'Для f(x)=x³+2x производная f′(x)=3x²+2.\n\nДля g(x)=x²sin(x) используем правило произведения: g′(x)=2xsin(x)+x²cos(x). Обратите внимание: производная произведения не равна произведению производных.',materialIds:['demo-material-2']},
          ]},
          'demo-schedule':{name:'Математический анализ · ИС-21',room:'204',demoDaily:true},
        };
        for(const [id,patch] of Object.entries(updates)){const row=(await tx.query('SELECT data FROM entities WHERE id=$1',[id])).rows[0];if(row)await tx.query('UPDATE entities SET data=$1 WHERE id=$2',[{...row.data,...patch,updatedAt:now()},id]);}
        // Only known synthetic demo records are transformed. Stored session snapshots and
        // user-authored curricula, files and students are preserved.
      }
      await tx.query('INSERT INTO schema_migrations(version) VALUES(3)');
    }
    if(demo){const row=(await tx.query("SELECT data FROM entities WHERE id='demo-schedule'")).rows[0];if(row?.data.demoDaily){const date=localDate();const data={...row.data,startsAt:`${date}T09:00:00+05:00`};await tx.query("UPDATE entities SET data=$1 WHERE id='demo-schedule'",[data]);}}
  });
}
