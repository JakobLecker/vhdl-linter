library ieee;
use ieee.std_logic_1164.all;

entity test_selected_name is
end entity;

architecture rtl of test_selected_name is
  type t1 is record
    apple  : std_ulogic;
  end record;

  type t2 is record
    banana : t1;
  end record;

  signal s1 : t1;
  signal s2 : t2;
begin

  s1.apple <= s2.banana.apple;

end architecture;
