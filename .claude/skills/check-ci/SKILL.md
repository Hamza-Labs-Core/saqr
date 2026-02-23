---
name: check-ci
description: check PR Checks and CI status
---

# Fix Workflow

Automate the checking CI

## Steps
                                                                                                                                                    
  1. **Check PR Checks** — Check PR Checks and CI status                                                            
  2. **Analyze Logs** — Go deep in each CI log and make sure you check why it failed and if any tests and checks are fake, false success, placeholders.                                                                                                                     
  3. **Add tests** — Write tests that reproduce the issue or update existing tests.                                                       
  4. **Run tests** — Run them, update tests until they **fail** (proving the bug exists)                           
  5. **Fix the issue** — Apply the minimal fix 
  6. **Run tests** — Run them, fix until they **pass** (proving the fix works)                                   
                                                                                                                                                    
  Never skip steps. Never combine steps. Each step must complete before moving to the next.                                                                                                  
                                                                                                                                                                 
         