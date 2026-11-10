//! A small, pure, fail-closed shell splitter for the Permission Policy. It splits a command into
//! simple commands (words, quotes resolved) so a rule matches only when every part matches.
//! Anything it cannot be sure about (substitution, expansion, redirects to files, subshells,
//! heredocs, assignments, `eval`, `sh -c`, ...) yields `None`, so no rule matches and the user is asked.

/// Wrappers that run another command or script; the rest of the line is not what runs.
const WRAPPERS: &[&str] = &["eval", "exec", "env", "source", ".", "command", "builtin", "nohup", "xargs", "sudo", "time"];
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish"];

/// Splits `cmd` into simple commands, each a list of words. `None` when it cannot be sure what runs.
pub fn simple_commands(cmd: &str) -> Option<Vec<Vec<String>>> {
    let mut p = Parser { commands: Vec::new(), words: Vec::new(), word: String::new(), in_word: false, redirect: false, need_command: false };
    let chars: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_control() && c != '\n' && c != '\t' {
            return None;
        }
        match c {
            ' ' | '\t' => p.end_word()?,
            '\n' => {
                p.end_word()?;
                p.end_command(false, true)?;
            }
            '\'' => {
                let end = chars[i + 1..].iter().position(|&x| x == '\'')? + i + 1;
                p.word.extend(&chars[i + 1..end]);
                p.in_word = true;
                i = end;
            }
            '"' => {
                i += 1;
                loop {
                    match *chars.get(i)? {
                        '"' => break,
                        '$' | '`' => return None,
                        '\\' => match *chars.get(i + 1)? {
                            n @ ('$' | '`' | '"' | '\\') => {
                                p.word.push(n);
                                i += 1;
                            }
                            '\n' => i += 1,
                            _ => p.word.push('\\'),
                        },
                        x => p.word.push(x),
                    }
                    i += 1;
                }
                p.in_word = true;
            }
            '\\' => {
                match *chars.get(i + 1)? {
                    '\n' => {}
                    n => {
                        p.word.push(n);
                        p.in_word = true;
                    }
                }
                i += 1;
            }
            '$' | '`' | '(' | ')' | '{' | '}' | '<' | '#' if c != '#' || !p.in_word => return None,
            ';' => {
                p.end_word()?;
                p.end_command(false, false)?;
            }
            '|' => {
                p.end_word()?;
                if next == Some('|') || next == Some('&') {
                    i += 1;
                }
                p.end_command(true, false)?;
            }
            '&' if next == Some('>') => {
                i += 1;
                p.start_redirect(&chars, &mut i, true)?;
            }
            '&' => {
                p.end_word()?;
                if next == Some('&') {
                    i += 1;
                    p.end_command(true, false)?;
                } else {
                    p.end_command(false, false)?;
                }
            }
            '>' => p.start_redirect(&chars, &mut i, false)?,
            x => {
                p.word.push(x);
                p.in_word = true;
            }
        }
        i += 1;
    }
    p.end_word()?;
    p.end_command(false, true)?;
    if p.need_command {
        return None;
    }
    p.commands.iter().all(|c| plain(c)).then_some(p.commands)
}

struct Parser {
    commands: Vec<Vec<String>>,
    words: Vec<String>,
    word: String,
    in_word: bool,
    /// The next word is the target of a redirect; only `/dev/null` is harmless.
    redirect: bool,
    /// An operator (`&&`, `||`, `|`) still waits for its right-hand command.
    need_command: bool,
}

impl Parser {
    fn end_word(&mut self) -> Option<()> {
        if !self.in_word {
            return Some(());
        }
        let w = std::mem::take(&mut self.word);
        self.in_word = false;
        if self.redirect {
            self.redirect = false;
            return (w == "/dev/null").then_some(());
        }
        self.words.push(w);
        Some(())
    }

    /// Ends the current simple command. `dangling`: an operator follows that needs a right-hand
    /// side. `lenient`: an empty command is fine (blank line, trailing `;`/`&` at the end).
    fn end_command(&mut self, dangling: bool, lenient: bool) -> Option<()> {
        if self.redirect {
            return None;
        }
        if self.words.is_empty() {
            return lenient.then_some(());
        }
        self.commands.push(std::mem::take(&mut self.words));
        self.need_command = dangling;
        Some(())
    }

    /// At a `>` (or `&>`): handles `>`, `>>`, `>|`, `>&N` (fd dup) and records the file target.
    fn start_redirect(&mut self, chars: &[char], i: &mut usize, amp: bool) -> Option<()> {
        // A bare number before `>` is a file descriptor, not an argument.
        if !amp && self.in_word && !self.word.is_empty() && self.word.chars().all(|c| c.is_ascii_digit()) {
            self.word.clear();
            self.in_word = false;
        } else {
            self.end_word()?;
        }
        if matches!(chars.get(*i + 1), Some('>') | Some('|')) {
            *i += 1;
        }
        if !amp && chars.get(*i + 1) == Some(&'&') {
            let mut j = *i + 2;
            let start = j;
            while chars.get(j).is_some_and(char::is_ascii_digit) {
                j += 1;
            }
            let dash = chars.get(j) == Some(&'-');
            if j > start || dash {
                *i = if dash { j } else { j - 1 };
                return Some(());
            }
            return None;
        }
        self.redirect = true;
        Some(())
    }
}

/// A simple command that runs what it names: no assignment prefix, wrapper or `sh -c`.
fn plain(words: &[String]) -> bool {
    let Some(first) = words.first() else { return false };
    let is_assign = first
        .split_once('=')
        .is_some_and(|(k, _)| !k.is_empty() && k.chars().enumerate().all(|(n, c)| c == '_' || c.is_ascii_alphabetic() || n > 0 && c.is_ascii_digit()));
    let name = first.rsplit('/').next().unwrap_or(first);
    let shell_c = SHELLS.contains(&name) && words[1..].iter().any(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('c'));
    !is_assign && !WRAPPERS.contains(&name) && !shell_c
}

/// Whether a command matches an Execute rule's pattern: it parses, and every simple command starts
/// with the pattern's words.
pub fn matches_prefix(pattern: &str, command: &str) -> bool {
    let pat: Vec<String> = match simple_commands(pattern) {
        Some(mut c) if c.len() == 1 => c.remove(0),
        _ => pattern.split_whitespace().map(str::to_owned).collect(),
    };
    if pat.is_empty() {
        return false;
    }
    simple_commands(command).is_some_and(|cmds| cmds.iter().all(|c| c.starts_with(&pat)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_matching_table() {
        let no = [
            "git status ; rm -rf ~",
            "git status;rm -rf ~",
            "git status && rm -rf ~",
            "git status || rm -rf ~",
            "git status | sh",
            "git status |& sh",
            "git status\nrm -rf ~",
            "git status & rm -rf ~",
            "git status $(rm -rf ~)",
            "git status `rm -rf ~`",
            "git status \"$(rm x)\"",
            "git status $HOME",
            "git status ${HOME}",
            "git status > file",
            "git status >file",
            "git status >> file",
            "git status >| file",
            "git status &> file",
            "git status 2> file",
            "git status >&file",
            "git status > /dev/null.bak",
            "git status > ",
            "git status <(ls)",
            "git status >(tee x)",
            "git status < /etc/passwd",
            "git status <<EOF\nx\nEOF",
            "(git status; rm x)",
            "{ git status; rm x; }",
            "git status; (rm x)",
            "bash -c 'git status'",
            "bash -lc 'git status'",
            "sh -c 'git status'",
            "/bin/zsh -c 'git status'",
            "eval git status",
            "exec git status",
            "env git status",
            "env FOO=1 git status",
            "VAR=1 git status",
            "FOO=$(x) git status",
            "git status';rm'",
            "git status 'unbalanced",
            "git status \"unbalanced",
            "git status \\",
            "git status\r; rm x",
            "git status\u{1b}[0m",
            "git status\0",
            "git status && ",
            "git status ;; rm x",
            "; git status",
            "git statusx",
            "git",
            "git status # c",
            "xargs git status",
            "sudo git status",
            "git status && rm -rf ~ && git status",
            "git status | tee out",
        ];
        for c in no {
            assert!(!matches_prefix("git status", c), "must not match: {c:?}");
        }
        let yes = [
            "git status",
            "git status --short",
            "git status && git status",
            "git status | git status -s",
            "git  status",
            "git\tstatus",
            "git status 2>&1",
            "git status >/dev/null",
            "git status > /dev/null 2>&1",
            "git status &> /dev/null",
            "git status 2>/dev/null",
            "'git' status",
            "\"git\" 'status'",
            "git status\n",
            "git status;",
            "git status &",
            "git status\ngit status -s",
            "git st\\atus",
            "git status \"a b\"",
        ];
        for c in yes {
            assert!(matches_prefix("git status", c), "must match: {c:?}");
        }
    }

    #[test]
    fn splits_into_words() {
        assert_eq!(simple_commands("a 'b c' \"d\\\"e\" f\\ g; h"), Some(vec![vec!["a".into(), "b c".into(), "d\"e".into(), "f g".into()], vec!["h".into()]]));
        assert_eq!(simple_commands("a 2>&1 | b"), Some(vec![vec!["a".into()], vec!["b".into()]]));
        assert_eq!(simple_commands(""), Some(vec![]));
    }

    #[test]
    fn single_word_rule() {
        assert!(matches_prefix("ls", "ls -la"));
        assert!(!matches_prefix("ls", "ls; rm x"));
        assert!(!matches_prefix("", "ls"));
    }
}
