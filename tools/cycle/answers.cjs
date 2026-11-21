'use strict';
// Structured session permissions only. Free text never grants permission.
const path=require('node:path');
const safe=require('../../.ai/bin/lib/path-safe.cjs');
const reader=require('./reader.cjs');
const oneLine=value=>String(value ?? '').replace(/[\r\n\u0085\u2028\u2029\x00-\x1f\x7f]/g,' ').slice(0,500);
function own(root,target,cwd=root) {
  if(typeof root!=='string' || typeof target!=='string' || !target || typeof cwd!=='string')return false;
  // Keep raw segments until the real-path walker has checked every component.
  const candidate=path.isAbsolute(target)?target:`${cwd}${path.sep}${target}`;
  const checked=safe.realInside(root,candidate,{allowRoot:true,refuseHardlinks:true});
  return checked.ok && !checked.rel.split('/').some(segment=>segment.toLowerCase()==='.git');
}
function classify(question) {
  const {operation:op,worktree}=question;
  if(!op || typeof op!=='object' || Array.isArray(op) || Object.keys(op).some(k=>!['kind','paths','argv'].includes(k)))return null;
  if(op.paths!==undefined && !Array.isArray(op.paths))return null;
  if(!own(worktree,question.cwd) || (op.paths || []).some(p=>!own(worktree,p,question.cwd)))return null;
  if(op.argv!==undefined && (!Array.isArray(op.argv) || op.argv.some(v=>typeof v!=='string')))return null;
  if(op.kind==='continue' && !op.argv && !op.paths)return 'continue';
  if(['read','edit'].includes(op.kind) && Array.isArray(op.paths) && op.paths.length && !op.argv)return op.kind;
  if(op.kind==='git' && !op.paths && Array.isArray(op.argv)) {
    const [verb,...args]=op.argv;
    if(!['status','diff','log','add','commit'].includes(verb))return null;
    // No config, aliases, external diff/textconv, hooksPath, pager or shell overrides.
    if(args.length===0 && ['status','diff','log'].includes(verb))return `git-${verb}`;
    if(verb==='add' && args[0]==='--' && args.length>1 && args.slice(1).every(p=>own(worktree,p,question.cwd)))return 'git-add';
    if(verb==='commit' && args.length===2 && args[0]==='-m' && typeof args[1]==='string')return 'git-commit';
  }
  if(op.kind==='test' && !op.paths && Array.isArray(op.argv)) {
    const [binary,flag,...files]=op.argv;
    if(binary==='node' && flag==='--test' && files.length && files.every(p=>!p.startsWith('-') && own(worktree,p,question.cwd)))return 'test';
    if(binary==='npm' && flag==='test' && files.length===0)return 'test';
  }
  return null;
}
function answerQuestion(question,data,seat) {
  const bound=seat && seat.name===question.seat && seat.client===question.client && typeof seat.worktree==='string' && typeof question.worktree==='string' &&
    require('./paths.cjs').same(seat.worktree,question.worktree);
  const cls=bound ? classify({...question,worktree:seat.worktree}) : null;
  const row=data.answers.find(r=>r.client===question.client && r.promptClass===cls && r.scope==='own-worktree');
  if(row)return {seat:question.seat,action:'answer',promptClass:cls,answer:row.answer};
  return {seat:question.seat,action:'operator',line:`OPERATOR seat=${oneLine(question.seat)} prompt=${oneLine(question.prompt)} options=${oneLine(JSON.stringify(question.options))} default=${oneLine(question.default)}`};
}
function questions(file,answersFile,seats=[]) {
  const data=reader.answers(answersFile),requests=reader.data(file,'questions');
  return requests.questions.map(q=>answerQuestion(q,data,seats.find(s=>s.name===q.seat)));
}
module.exports={classify,answerQuestion,questions,oneLine,own};
