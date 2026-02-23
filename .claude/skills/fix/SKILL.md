---
name: fix
description: TDD
---

# Fix Workflow

Automate the full release cycle: build -> test -> commit -> tag -> push

## Steps
                                                                                                                                                    
  1. **Add tests** — Write tests that reproduce the bug                                                            
  2. **Run tests** — Run them, update tests until they **fail** (proving the bug exists)                                                                                                     
  3. **Fix the issue** — Apply the minimal fix                                                                                                                                               
  4. **Run tests** — Run them, fix until they **pass** (proving the fix works)                                                                                                               
                                                                                                                                                                                             
  Never skip steps. Never combine steps. Each step must complete before moving to the next.                                                                                                  
                                                                                                                                                                 
                                      