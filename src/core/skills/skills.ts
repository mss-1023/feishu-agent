/**
 * Skill 建议管理 — 记录和查询用户提交的 Skill 优化建议。
 */
import type { SkillSuggestion } from '../../types.js';
import { addSkillSuggestionToDb, listSkillSuggestionsFromDb } from '../session/storage.js';

export function addSkillSuggestion(
  skillName: string,
  description: string,
  sessionKey: string,
): SkillSuggestion {
  return addSkillSuggestionToDb(skillName, description, sessionKey);
}

export function listSkillSuggestions(status: 'pending' | 'done' | '' = 'pending') {
  return listSkillSuggestionsFromDb(status);
}
