import type { DB } from './db.js';
import { passwordHash, now } from './security.js';

export async function seed(db: DB, demo: boolean, email?: string, password?: string) {
  await db.transaction(async tx => {
    if (demo && !(await tx.query("SELECT id FROM institutions WHERE id='demo-school'")).rows.length) {
      const createdAt = now();
      const institutions = [
        { id: 'demo-school', name: 'Школа нового поколения', type: 'SCHOOL', language: 'ru', settings: { allowExternalAI: false, voice: 'ru-RU', retentionDays: 365, modules: ['classroom','attendance','quizzes','assignments'] }, createdAt },
        { id: 'demo-university', name: 'Демонстрационный университет', type: 'UNIVERSITY', language: 'ru', settings: { allowExternalAI: false, retentionDays: 365 }, createdAt },
      ];
      for (const institution of institutions) await tx.query('INSERT INTO institutions(id,data) VALUES($1,$2)', [institution.id, institution]);
      const users = [
        { id:'demo-teacher', name:'Александра Смирнова', email:'demo@aiteacher.local', role:'TEACHER', institutionId:'demo-school', password:'PepeOnly-teacher-2026!', groupIds:['demo-group-7a','demo-group-7b'] },
        { id:'demo-admin', name:'Мария Иванова', email:'admin@aiteacher.local', role:'ADMIN', institutionId:'demo-school', password:'PepeOnly-admin-2026!' },
        { id:'demo-super', name:'Администратор платформы', email:'super@aiteacher.local', role:'SUPER_ADMIN', institutionId:null, password:'PepeOnly-super-2026!' },
        { id:'demo-director', name:'Дмитрий Орлов', email:'director@aiteacher.local', role:'DIRECTOR', institutionId:'demo-school', password:'PepeOnly-director-2026!' },
        { id:'demo-technician', name:'Техническая поддержка', email:'tech@aiteacher.local', role:'TECHNICIAN', institutionId:'demo-school', password:'PepeOnly-technician-2026!' },
        { id:'other-teacher', name:'Преподаватель другого учреждения', email:'other@aiteacher.local', role:'TEACHER', institutionId:'demo-university', password:'PepeOnly-external-teacher-2026!' },
        { id:'demo-student-user', name:'Арина Волкова', email:'student@aiteacher.local', role:'STUDENT', institutionId:'demo-school', password:'PepeOnly-student-2026!', studentId:'demo-student-1' },
        { id:'demo-parent', name:'Родитель Арины Волковой', email:'parent@aiteacher.local', role:'PARENT', institutionId:'demo-school', password:'PepeOnly-parent-2026!', childIds:['demo-student-1'] },
      ];
      for (const {password: pass, ...user} of users) await tx.query('INSERT INTO users(id,institution_id,email,password_hash,data) VALUES($1,$2,$3,$4,$5)',[user.id,user.institutionId,user.email,passwordHash(pass),{...user, active:true}]);
      const entities: {kind:string; data:any}[] = [];
      const add = (kind:string, data:any) => entities.push({kind,data:{institutionId:'demo-school',createdAt,updatedAt:createdAt,...data}});
      add('departments',{id:'demo-science', name:'Естественные науки'});
      add('groups',{id:'demo-group-7a',name:'7 «А»',level:'7 класс',teacherId:'demo-teacher',departmentId:'demo-science'});
      add('groups',{id:'demo-group-7b',name:'7 «Б»',level:'7 класс',teacherId:'demo-teacher',departmentId:'demo-science'});
      const names = ['Арина Волкова','Марк Соколов','София Кузнецова','Тимур Алимов','Ева Петрова','Михаил Новиков','Амина Каримова','Даниил Морозов','Анна Лебедева','Лев Павлов','Виктория Сидорова','Артём Попов'];
      names.forEach((name,i)=>add('students',{id:`demo-student-${i+1}`,name,groupId:i<8?'demo-group-7a':'demo-group-7b'}));
      add('subjects',{id:'demo-biology',name:'Биология',description:'Растения, живые системы и научное мышление.'});
      add('subjects',{id:'demo-math',name:'Математика',description:'Задачи, логика и проверка решений.'});
      add('materials',{id:'demo-material-1',name:'Фотосинтез: основные понятия',subjectId:'demo-biology',topic:'Фотосинтез',language:'ru',ageLevel:'7 класс',type:'text',content:'Фотосинтез — процесс образования органических веществ из углекислого газа и воды с использованием энергии света. В растительных клетках он протекает в хлоропластах, содержащих пигмент хлорофилл. В ходе процесса выделяется кислород. Упрощённая суммарная схема: 6CO₂ + 6H₂O + свет → C₆H₁₂O₆ + 6O₂. Глюкоза используется растением для роста и дыхания, а её избыток может запасаться в виде крахмала.',source:'Авторский демонстрационный учебный материал AI Teacher',license:'Учебная демонстрация',approved:true});
      add('materials',{id:'demo-material-2',name:'От чего зависит фотосинтез',subjectId:'demo-biology',topic:'Факторы фотосинтеза',language:'ru',ageLevel:'7 класс',type:'text',content:'На скорость фотосинтеза влияют освещённость, концентрация углекислого газа, температура и обеспеченность водой. При недостатке одного фактора увеличение другого не всегда ускоряет процесс. Растения дышат и днём, и ночью, а фотосинтез требует света. Основной источник кислорода, выделяемого при фотосинтезе, — вода. Корни поглощают воду, листья получают углекислый газ через устьица.',source:'Авторский демонстрационный учебный материал AI Teacher',license:'Учебная демонстрация',approved:true});
      add('lessons',{id:'demo-photosynthesis',name:'Фотосинтез: энергия солнечного света',subjectId:'demo-biology',groupId:'demo-group-7a',description:'Разберём, как свет превращается в химическую энергию и почему этот процесс важен для жизни на Земле.',duration:40,language:'ru',approved:true,sections:[
        {id:'intro',title:'Растение — маленькая солнечная лаборатория',content:'Растения используют энергию солнечного света, чтобы создавать органические вещества. Этот процесс называется фотосинтезом.\n\nОн происходит преимущественно в зелёных частях растения. Подумайте: откуда дерево берёт вещество для роста? Большая часть углерода в его органических веществах поступает из углекислого газа воздуха, а не из почвы.',materialIds:['demo-material-1']},
        {id:'process',title:'Что нужно для фотосинтеза',content:'Для фотосинтеза нужны свет, вода и углекислый газ.\n\nХлорофилл в хлоропластах поглощает свет. Вода поступает из почвы через корни, углекислый газ — через устьица листьев. Образуются органические вещества, например глюкоза, и выделяется кислород.\n\nУпрощённая схема: 6CO₂ + 6H₂O + свет → C₆H₁₂O₆ + 6O₂. Энергия света запасается в химических связях органических веществ.',materialIds:['demo-material-1']},
        {id:'factors',title:'Почему скорость процесса меняется',content:'Интенсивность фотосинтеза зависит от света, температуры, количества углекислого газа и воды. Недостаток одного из факторов ограничивает весь процесс. Растение продолжает дышать в темноте, но фотосинтез без света прекращается. Слишком высокая температура и недостаток воды могут снижать скорость фотосинтеза.',materialIds:['demo-material-2']},
        {id:'meaning',title:'Значение для жизни на Земле',content:'Фотосинтез создаёт органические вещества, служащие основой большинства пищевых цепей, и пополняет атмосферу кислородом. Растения сами используют часть глюкозы при дыхании. Остальная часть идёт на рост или запасается, например в виде крахмала. Сформулируйте одним предложением связь между Солнцем, растением и человеком.',materialIds:['demo-material-1','demo-material-2']},
      ],quiz:[
        {id:'q1',question:'Где в растительной клетке происходит фотосинтез?',options:['В ядре','В хлоропластах','В вакуолях','В клеточной стенке'],correctIndex:1,explanation:'Хлоропласты содержат хлорофилл, поглощающий свет.'},
        {id:'q2',question:'Какие вещества нужны для фотосинтеза?',options:['Вода и углекислый газ','Кислород и крахмал','Глюкоза и кислород','Азот и соль'],correctIndex:0,explanation:'Из воды и углекислого газа с использованием света образуются органические вещества.'},
        {id:'q3',question:'Что выделяется в ходе фотосинтеза?',options:['Азот','Кислород','Углекислый газ','Водород'],correctIndex:1,explanation:'При фотосинтезе выделяется кислород, источником которого является вода.'},
        {id:'q4',question:'Какое утверждение верно?',options:['Растения дышат только ночью','Для дыхания всегда нужен свет','Растения дышат и днём, и ночью','Фотосинтез идёт только в корнях'],correctIndex:2,explanation:'Дыхание постоянно обеспечивает клетки энергией. Фотосинтез требует света.'},
      ]});
      add('assignments',{id:'demo-assignment',name:'Нарисовать схему фотосинтеза',groupId:'demo-group-7a',lessonId:'demo-photosynthesis',instructions:'Нарисуйте схему: свет + вода + углекислый газ → органические вещества + кислород. Подпишите роль каждого компонента.'});
      add('devices',{id:'demo-panel',name:'Панель кабинета 204',room:'204',type:'panel',status:'unknown',model:'Учебная панель (демо)'});
      add('devices',{id:'demo-microphone',name:'Микрофон кабинета 204',room:'204',type:'microphone',status:'unknown',model:'USB-микрофон (демо)'});
      const startsAt = new Date(); startsAt.setHours(10,0,0,0);
      add('schedule',{id:'demo-schedule',name:'Биология • 7 «А»',lessonId:'demo-photosynthesis',groupId:'demo-group-7a',teacherId:'demo-teacher',startsAt:startsAt.toISOString(),room:'204'});
      for(const {kind,data} of entities) await tx.query('INSERT INTO entities(id,institution_id,kind,data) VALUES($1,$2,$3,$4)',[data.id,data.institutionId,kind,data]);
    }
    if(email && password && !(await tx.query('SELECT id FROM users WHERE email=$1',[email.toLowerCase()])).rows.length) {
      const id = 'bootstrap-'+Date.now();
      await tx.query('INSERT INTO users(id,email,password_hash,data) VALUES($1,$2,$3,$4)',[id,email.toLowerCase(),passwordHash(password),{id,name:'Администратор платформы',email:email.toLowerCase(),role:'SUPER_ADMIN',institutionId:null,active:true}]);
    }
  });
}
