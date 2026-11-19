-- SQLyard Sample Dataset: sample-library
-- Portable SQL for MariaDB 11.4 and SQLite 3 (MIT License)
-- Schema: Authors, Books, BookAuthors (N:M), Members (nullable self-FK), Loans (DATE, DECIMAL)
--
-- Teaching hooks:
--   - Books never loaned: book_id 110, 112 (LEFT JOIN, COUNT(col) vs COUNT(*))
--   - Members without loans: member_id 208, 209 (LEFT JOIN)
--   - Author without books: author_id 10 (LEFT JOIN)
--   - 'Nora Lindqvist' is both an Author (1) and a Member (201) (UNION vs UNION ALL)
--   - Open loans (314, 315) have NULL returned_date and late_fee (COUNT(*) vs COUNT(col), IS NULL)
--   - Self-referencing Members.referred_by nullable FK (self-join)
--   - Late fee = 0.50 per day late (302: 5d = 2.50; 305: 6d = 3.00; 310: 8d = 4.00)

CREATE TABLE Authors (
  author_id INTEGER NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  country VARCHAR(60) NOT NULL,
  birth_year INTEGER NOT NULL,
  PRIMARY KEY (author_id)
);

CREATE TABLE Books (
  book_id INTEGER NOT NULL,
  title VARCHAR(160) NOT NULL,
  genre VARCHAR(40) NOT NULL,
  published_year INTEGER NOT NULL,
  price DECIMAL(6, 2) NOT NULL,
  copies_total INTEGER NOT NULL,
  PRIMARY KEY (book_id)
);

CREATE TABLE BookAuthors (
  book_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  author_role VARCHAR(30) NOT NULL,
  PRIMARY KEY (book_id, author_id),
  CONSTRAINT fk_bookauthors_book
    FOREIGN KEY (book_id) REFERENCES Books (book_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_bookauthors_author
    FOREIGN KEY (author_id) REFERENCES Authors (author_id)
    ON DELETE RESTRICT
);

CREATE TABLE Members (
  member_id INTEGER NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  joined_date DATE NOT NULL,
  referred_by INTEGER NULL,
  PRIMARY KEY (member_id),
  CONSTRAINT fk_members_referrer
    FOREIGN KEY (referred_by) REFERENCES Members (member_id)
    ON DELETE SET NULL
);

CREATE TABLE Loans (
  loan_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  loaned_date DATE NOT NULL,
  due_date DATE NOT NULL,
  returned_date DATE NULL,
  late_fee DECIMAL(6, 2) NULL,
  PRIMARY KEY (loan_id),
  CONSTRAINT fk_loans_book
    FOREIGN KEY (book_id) REFERENCES Books (book_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_loans_member
    FOREIGN KEY (member_id) REFERENCES Members (member_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_loans_dates
    CHECK (due_date > loaned_date)
);

INSERT INTO Authors (author_id, full_name, country, birth_year) VALUES
  (1, 'Nora Lindqvist', 'Sweden', 1978),
  (2, 'Kenji Takahashi', 'Japan', 1969),
  (3, 'Amara Osei', 'Ghana', 1984),
  (4, 'Mateo Delgado', 'Spain', 1975),
  (5, 'Claire Beaumont', 'France', 1981),
  (6, 'Tomasz Kowalski', 'Poland', 1964),
  (7, 'Priya Natarajan', 'India', 1988),
  (8, 'Henrik Solberg', 'Norway', 1972),
  (9, 'Sofia Conti', 'Italy', 1990),
  (10, 'David Alvarez', 'Chile', 1983);

INSERT INTO Books (book_id, title, genre, published_year, price, copies_total) VALUES
  (101, 'Foundations of Relational Storage', 'Technology', 2021, 39.50, 3),
  (102, 'Harbor of Glass', 'Fiction', 2019, 16.00, 2),
  (103, 'Maps of the Silk Coast', 'History', 2018, 28.75, 2),
  (104, 'Signals in Deep Water', 'Science', 2022, 31.20, 2),
  (105, 'Practical Query Tuning', 'Technology', 2023, 44.00, 3),
  (106, 'The Clockmaker of Gdansk', 'Mystery', 2020, 18.50, 2),
  (107, 'Quiet Orbits', 'Science', 2024, 26.40, 1),
  (108, 'Letters from Bergen', 'Fiction', 2017, 14.90, 2),
  (109, 'Distributed Systems Field Guide', 'Technology', 2024, 48.00, 2),
  (110, 'The Salt Merchant Ledger', 'History', 2021, 24.50, 1),
  (111, 'Midnight at Pier Nine', 'Mystery', 2023, 17.25, 2),
  (112, 'Winter Over the Fjord', 'Fiction', 2025, 19.80, 1);

INSERT INTO BookAuthors (book_id, author_id, author_role) VALUES
  (101, 1, 'Lead Author'),
  (101, 2, 'Co-Author'),
  (102, 3, 'Lead Author'),
  (103, 4, 'Lead Author'),
  (104, 5, 'Lead Author'),
  (105, 2, 'Lead Author'),
  (106, 6, 'Lead Author'),
  (107, 7, 'Lead Author'),
  (107, 5, 'Co-Author'),
  (108, 8, 'Lead Author'),
  (109, 7, 'Lead Author'),
  (110, 4, 'Lead Author'),
  (111, 9, 'Lead Author'),
  (112, 1, 'Lead Author');

INSERT INTO Members (member_id, full_name, email, joined_date, referred_by) VALUES
  (201, 'Nora Lindqvist', 'nora.lindqvist@example.org', '2024-01-15', NULL),
  (202, 'Liam Byrne', 'liam.byrne@example.org', '2024-02-20', 201),
  (203, 'Mei-Ling Zhou', 'meiling.zhou@example.org', '2024-03-10', NULL),
  (204, 'Omar Farouk', 'omar.farouk@example.org', '2024-05-04', 202),
  (205, 'Hannah Richter', 'hannah.richter@example.org', '2024-07-18', NULL),
  (206, 'Lucas Ferreira', 'lucas.ferreira@example.org', '2024-09-01', 203),
  (207, 'Anika Patel', 'anika.patel@example.org', '2025-01-12', 201),
  (208, 'Jonas Lind', 'jonas.lind@example.org', '2025-04-22', NULL),
  (209, 'Chloe Martin', 'chloe.martin@example.org', '2025-08-05', 205);

INSERT INTO Loans (loan_id, book_id, member_id, loaned_date, due_date, returned_date, late_fee) VALUES
  (301, 101, 201, '2025-01-10', '2025-01-24', '2025-01-21', 0.00),
  (302, 102, 202, '2025-01-14', '2025-01-28', '2025-02-02', 2.50),
  (303, 105, 203, '2025-02-01', '2025-02-15', '2025-02-14', 0.00),
  (304, 103, 204, '2025-02-08', '2025-02-22', '2025-02-20', 0.00),
  (305, 101, 203, '2025-02-18', '2025-03-04', '2025-03-10', 3.00),
  (306, 106, 205, '2025-03-05', '2025-03-19', '2025-03-18', 0.00),
  (307, 104, 206, '2025-03-12', '2025-03-26', '2025-03-25', 0.00),
  (308, 107, 201, '2025-04-02', '2025-04-16', '2025-04-15', 0.00),
  (309, 108, 202, '2025-04-10', '2025-04-24', '2025-04-22', 0.00),
  (310, 109, 203, '2025-05-01', '2025-05-15', '2025-05-23', 4.00),
  (311, 105, 207, '2025-05-14', '2025-05-28', '2025-05-27', 0.00),
  (312, 111, 204, '2025-06-03', '2025-06-17', '2025-06-15', 0.00),
  (313, 101, 205, '2025-06-18', '2025-07-02', '2025-07-01', 0.00),
  (314, 109, 206, '2025-09-01', '2025-09-15', NULL, NULL),
  (315, 102, 207, '2025-09-05', '2025-09-19', NULL, NULL);
