// Pure VENUS standing resolution (`resolveHierarchyStanding`), using the
// master `HierarchyDetailGrade` rows of the current corpus as fixtures.
//
//   node --test src/services/hierarchy.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveHierarchyStanding } from './hierarchy.ts';

type GradeRow = {
  Id: string;
  HierarchyGradeId: string;
  RequiredHierarchyPoint: number | null;
  RequiredHierarchyRank: number | null;
};

const GRADES: GradeRow[] = [
  { Id: 'hie-001-001', HierarchyGradeId: 'hie-001', RequiredHierarchyPoint: 25000, RequiredHierarchyRank: 4 },
  { Id: 'hie-002-001', HierarchyGradeId: 'hie-002', RequiredHierarchyPoint: 15000, RequiredHierarchyRank: 1000 },
  { Id: 'hie-003-001', HierarchyGradeId: 'hie-003', RequiredHierarchyPoint: 10000, RequiredHierarchyRank: 2000 },
  { Id: 'hie-004-001', HierarchyGradeId: 'hie-004', RequiredHierarchyPoint: 7000, RequiredHierarchyRank: null },
  { Id: 'hie-004-002', HierarchyGradeId: 'hie-004', RequiredHierarchyPoint: 6200, RequiredHierarchyRank: null },
  { Id: 'hie-004-003', HierarchyGradeId: 'hie-004', RequiredHierarchyPoint: 5400, RequiredHierarchyRank: null },
  { Id: 'hie-005-001', HierarchyGradeId: 'hie-005', RequiredHierarchyPoint: 4500, RequiredHierarchyRank: null },
  { Id: 'hie-005-002', HierarchyGradeId: 'hie-005', RequiredHierarchyPoint: 3700, RequiredHierarchyRank: null },
  { Id: 'hie-005-003', HierarchyGradeId: 'hie-005', RequiredHierarchyPoint: 3000, RequiredHierarchyRank: null },
  { Id: 'hie-006-001', HierarchyGradeId: 'hie-006', RequiredHierarchyPoint: 2000, RequiredHierarchyRank: null },
  { Id: 'hie-006-002', HierarchyGradeId: 'hie-006', RequiredHierarchyPoint: 1500, RequiredHierarchyRank: null },
  { Id: 'hie-006-003', HierarchyGradeId: 'hie-006', RequiredHierarchyPoint: 1000, RequiredHierarchyRank: null },
  { Id: 'hie-007-001', HierarchyGradeId: 'hie-007', RequiredHierarchyPoint: 600, RequiredHierarchyRank: null },
  { Id: 'hie-007-002', HierarchyGradeId: 'hie-007', RequiredHierarchyPoint: 300, RequiredHierarchyRank: null },
  { Id: 'hie-007-003', HierarchyGradeId: 'hie-007', RequiredHierarchyPoint: null, RequiredHierarchyRank: null },
];

test('below Platinum: strongest non-leaderboard grade, rank 0', () => {
  assert.deepEqual(resolveHierarchyStanding(GRADES, 0, 0), {
    detailGradeId: 'hie-007-003',
    gradeId: 'hie-007',
    rank: 0,
  });
  assert.deepEqual(resolveHierarchyStanding(GRADES, 600, 0), {
    detailGradeId: 'hie-007-001',
    gradeId: 'hie-007',
    rank: 0,
  });
  assert.deepEqual(resolveHierarchyStanding(GRADES, 9999, 0), {
    detailGradeId: 'hie-004-001',
    gradeId: 'hie-004',
    rank: 0,
  });
  // A Platinum-point player whose rank exceeds Platinum's 2000 falls back to
  // the strongest non-leaderboard grade (Gold) at rank 0.
  assert.deepEqual(resolveHierarchyStanding(GRADES, 12000, 999999), {
    detailGradeId: 'hie-004-001',
    gradeId: 'hie-004',
    rank: 0,
  });
});

test('Diamond, Platinum and BIG4 use the server-wide leaderboard rank', () => {
  assert.deepEqual(resolveHierarchyStanding(GRADES, 15000, 5), {
    detailGradeId: 'hie-002-001',
    gradeId: 'hie-002',
    rank: 5,
  });
  // Platinum is the leaderboard floor: 10000+ points is ranked, and rank 2000
  // is still inside Platinum's window.
  assert.deepEqual(resolveHierarchyStanding(GRADES, 12000, 2000), {
    detailGradeId: 'hie-003-001',
    gradeId: 'hie-003',
    rank: 2000,
  });
  assert.deepEqual(resolveHierarchyStanding(GRADES, 30000, 4), {
    detailGradeId: 'hie-001-001',
    gradeId: 'hie-001',
    rank: 4,
  });
  // BIG4 (rank 4) does not fit at rank 5, so the strongest fit is Diamond.
  assert.deepEqual(resolveHierarchyStanding(GRADES, 30000, 5), {
    detailGradeId: 'hie-002-001',
    gradeId: 'hie-002',
    rank: 5,
  });
  // Diamond needs 15000 points; BIG4 needs 25000.
  assert.deepEqual(resolveHierarchyStanding(GRADES, 20000, 1), {
    detailGradeId: 'hie-002-001',
    gradeId: 'hie-002',
    rank: 1,
  });
});

test('a rank beyond the Platinum window falls back to the non-leaderboard grade at rank 0', () => {
  // 16000 points is above Diamond's floor but past Diamond's rank window, so
  // it lands on Platinum while the rank is <= 2000.
  assert.deepEqual(resolveHierarchyStanding(GRADES, 16000, 1001), {
    detailGradeId: 'hie-003-001',
    gradeId: 'hie-003',
    rank: 1001,
  });
  assert.deepEqual(resolveHierarchyStanding(GRADES, 16000, 2001), {
    detailGradeId: 'hie-004-001',
    gradeId: 'hie-004',
    rank: 0,
  });
});
