//! Lookalike matching for vendor names and invoice numbers. This is the Postgres-free
//! fallback the blueprint calls for; Elasticsearch can replace it later.

/// Lower-case, keep letters and digits and drop legal suffixes, so "ACME Ltd." == "acme".
/// Used for exact vendor matching; it deliberately does not fold homoglyphs.
pub fn normalize_name(name: &str) -> String {
    let lowered = name.to_lowercase();
    let mut words: Vec<String> = lowered
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    const SUFFIXES: [&str; 10] = ["ltd", "limited", "inc", "llc", "co", "corp", "company", "plc", "gmbh", "sa"];
    while words.len() > 1 && SUFFIXES.contains(&words.last().unwrap().as_str()) {
        words.pop();
    }
    words.concat()
}

/// The name with lookalike characters folded ("0"->"o", "1"/"l"->"i", "rn"->"m", ...), so
/// "Acrne" and "Acme" share a skeleton. Used only to detect lookalikes, never to accept one.
pub fn skeleton(name: &str) -> String {
    fold_homoglyphs(&normalize_name(name))
}

fn fold_homoglyphs(s: &str) -> String {
    s.replace("rn", "m")
        .replace("vv", "w")
        .chars()
        .map(|c| match c {
            '0' => 'o',
            '1' | 'l' | '|' => 'i',
            '5' => 's',
            '3' => 'e',
            '4' => 'a',
            '8' => 'b',
            // Cyrillic and Greek letters that look Latin.
            'а' => 'a', 'е' => 'e', 'о' | 'ο' => 'o', 'р' | 'ρ' => 'p', 'с' => 'c', 'у' => 'y', 'х' => 'x', 'і' | 'ι' => 'i',
            'к' | 'κ' => 'k', 'м' => 'm', 'т' | 'τ' => 't', 'в' => 'b', 'н' => 'h', 'ν' => 'v',
            other => other,
        })
        .collect()
}

/// Invoice numbers compare without punctuation, case or leading zeros: "INV-0042" == "inv42".
pub fn normalize_invoice_number(number: &str) -> String {
    let compact: String = number.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    // Strip leading zeros from the trailing numeric part.
    let split = compact.find(|c: char| c.is_ascii_digit()).unwrap_or(compact.len());
    let (prefix, digits) = compact.split_at(split);
    let trimmed = digits.trim_start_matches('0');
    format!("{prefix}{}", if trimmed.is_empty() && !digits.is_empty() { "0" } else { trimmed })
}

pub fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// True when a person could mistake one vendor name for the other (including identical ones).
pub fn names_look_alike(a: &str, b: &str) -> bool {
    let (na, nb) = (skeleton(a), skeleton(b));
    if na.is_empty() || nb.is_empty() {
        return false;
    }
    if na == nb {
        return true;
    }
    let longest = na.chars().count().max(nb.chars().count());
    let allowed = if longest <= 5 { 1 } else { 2 };
    levenshtein(&na, &nb) <= allowed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_suffixes_and_homoglyphs() {
        assert_eq!(normalize_name("ACME Ltd."), normalize_name("Acme"));
        assert_ne!(normalize_name("Acrne Limited"), normalize_name("Acme"));
        assert_eq!(skeleton("Acrne Limited"), skeleton("Acme"));
        assert_eq!(skeleton("G00gle Inc"), skeleton("google"));
        // Cyrillic "о" in Contoso: not an exact match, but the same skeleton.
        assert_ne!(normalize_name("C\u{043e}ntoso"), normalize_name("Contoso"));
        assert_eq!(skeleton("C\u{043e}ntoso"), skeleton("Contoso"));
    }

    #[test]
    fn lookalikes() {
        assert!(names_look_alike("Northwind Design Studio", "Northwlnd Design Studio"));
        assert!(names_look_alike("Northwind Design", "Northwind Designs"));
        assert!(!names_look_alike("Northwind Design", "Contoso Legal"));
        assert!(!names_look_alike("Abc", "Xyz"));
    }

    #[test]
    fn invoice_numbers() {
        assert_eq!(normalize_invoice_number("INV-0042"), normalize_invoice_number("inv42"));
        assert_eq!(normalize_invoice_number("2026/001"), "2026001");
        assert_eq!(normalize_invoice_number("A-007"), "a7");
        assert_ne!(normalize_invoice_number("INV-42"), normalize_invoice_number("INV-43"));
        assert_eq!(normalize_invoice_number("000"), "0");
    }

    #[test]
    fn levenshtein_basics() {
        assert_eq!(levenshtein("kitten", "sitting"), 3);
        assert_eq!(levenshtein("", "abc"), 3);
        assert_eq!(levenshtein("same", "same"), 0);
    }
}
