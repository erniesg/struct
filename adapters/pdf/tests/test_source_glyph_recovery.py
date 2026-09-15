"""Font-verified glyph repair must never infer symbols from ordinary ASCII."""
from __future__ import annotations

import sys
import base64
import zlib
import re
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf_text import Char, Line, PageText, _merge_recovered_glyph, _verified_symbol_encoding, _type1_decrypt


class Stream(dict):
    def __init__(self, data: bytes, **metadata):
        super().__init__(metadata)
        self.data = data

    def get_data(self):
        return self.data


# Actual embedded bbding Type1 subset, whose decrypted glyph programs also
# match the independent CTAN niceframe/bbding10.pfb canonical distribution.
# Compression stores the original program and notices, not a metadata stub.
_FONT_PROGRAM = (
    'c$}?S4U8RC6~;6w8BhpK0S(9@*mMcqzM1#4eY+sicDrr^?Jm3B_SJ2Jv-9rT9d_Q#>&(3Eyi6Yf1%HU9f-'
    'yh{2v#M4K(Il<LL@2`6oCdK#-M3M#0aLwMhUeA&$;)`&wIOXw@V0Rcka38o_o%@-'
    '*@iMF28Viw0lk2nP3Bs?RRUd)IOM)D4X^qs4BKpRaw5g-!bY{X8WV{TFo+9d4zdR-'
    '8Gok2NfJ82cY6+)3;b(+}^@m&vfj*l&N(t(|wfn>pm)ObZi(he8}b@o9oMK_z$wGT8I=Kw+}`fs{)%$R&#aFn3`6WuXAb**PNX4`'
    '+zI4GE6ku)nJ$DPXWa=;JA|vaQ>E&T~oea>&s-'
    'w{|afW@+zxr=3lHV=N@!xYIimt&#(%`pJO(2qv;aMq^+r1v7^Zh+FZWgF0XT{ltfRVvHhmY42-'
    'Xlk=dTMon3YqwJN4v=BX{$Ynd_I+*xNE`lSwvltebke8_7>bU+2R6IftOWoUxUjT+;f8i{qg+ze|@4Jx|jv8GvJ_)7^reTISW)>$'
    ')5ceJ(?EemB6S80MxnzoWy*PzTQqP<b~T{D1j6_;59mHvyrc3=w2j%_s(^-'
    'X$}L1xR=(Xsy0B{Jl=bM0CufUrB8gYK*fnnpiV{LyT+QyRnQ$FWC)qE-McUs&DK+mloIXHULREbb7B!@4OQR+C9K*cAtQMO>KBD7'
    'G1aSm=_7y%<_2-Q@VD!JunVz=Q2-LG1tz?9$pN8K_$p&rp|0&8&XCYFdr?G`2EAIdpAgWwTyw@7>_*mT9c9C#^UorZ-'
    '>)tUPS`#+1N_kdN7A=31uBh8@o&-'
    'U1RsZR^`SWg62q^E@bsE@qe8rd)3u4qxSLp$Bx=)f)<~Dz*v`YJgy80f#PRR@sh^L!egon^;|3g;pn*hYYigZv2gMAzCd(tGTFUI'
    '-~Bo$TYsV=u6bDm>4i)0W*|=4W-'
    'RvBkQjjT|c~LWX<NG5l*UM*POv+1%y*OFh=@A4<U{bv=}3oX=>Sr3~Q48y3bOW=?`s3Hw;P;3g%E4P82BYSqd9XdjRoPcUh?QfY#'
    'I8)URY}y65e3+%go3xn7~S)~d5DI{xrrd<W@_`sKl`FrGsyh$gF!+Inpe#*rmi$f=MkLOu`qA{6q_qrvJd6pP3?4WjW|<`}<)M3B'
    '!xAxndbL{MUCj~GR6j82&qABw`SA%BXwqxA{b!!jBdVdye02CcWax?Ah*Re^6pFxv2N5)U>YVBDJHM#XoHWx)uI@&I=q=FSK)LeB'
    '$)7FIC_mkR10k`hq^0~R6*s~$`t`EiMAmToXAzcfnjOUO-483&I~$rn6>%FMNOi??{WRYFZG=6bY3v8T7QDivA|tjvHF47-'
    'jY21BaCf-I^aYpfEYvu>wp0cilCGPjBn8crR<qKdDCt)rRiI`NPhBzjpQD{_$>;0*GqB=W(N%;gQ6y?<+|ERj>R*Qm|Kn^WYT(-'
    'cPYatq5!MiSL0uv|czBP8U0q<rX*+xN3h(xY)@exT5bAy}w7at&TMz?cajQ}qL=iXAdTwGD;b-'
    '?TwlR%*I29UliEY?G3M;IXL9jf4yN6)KBDFy%e-X-rRlI~b{l{<oMtiF+I`epNk)nsU|S%y%%9%8^J>Iz3b_TF0epIW9ESa|*lp0'
    'ho!gMrlk`DHEdV^NvZEd3aD`N`?ircp;CQ3b`n5<tk3jW%`5%!l@b2#cCxGgYa{k_*61RzLAZ@Mm|V=H?)*I_1#cYay7P-'
    'OWDb#?Br5*aw$8xl$~74j+U~crR-'
    '$!n>#3*4Qe*BBDO}w(s47SvD^`_KEV^fEpT@t$)qpOVR%Yd=OF(*#8QZQDh;O}=p%k<ax6EQrQR&{W~nzzz1$!40@t4V&jaES@{s'
    'wY+!vlDo;IFGo>(3TxgRfkrcsDO4dSmxK9<E_ja)3tMM+CimLx1mdy@1d<#ECVZV0UsloGT^9xhcm0x5HJ0>wkL<parcbI9?06lN'
    '-xSu1VBlNm>)5|Xmk!AN!iBaw}$t%`PAEzB_25j!Z4<pV81z>i|l1ac3K+oTmYVkYv+)5>R#PbG}Qz)O(C1})uA9<(^<Cb*=yy(v'
    '7&O}FSOq1p@uEb|iSNjJ5K@R-tQ%a8<-'
    'mcm#~3aWKW4AskJSwjR52+q+c$;O7nc1o;d1TXTlv^h!gv$Q$Uh%XVtH9?w)<f`CH)YJrNL~WzYiC8rmgo`JSvQqY4-'
    'S+UHRfQNhm{eXHDGdZ>jxt_}w*fDb2(={FO4=xCiVNc;Z8S+8SYR5AE{IWp-'
    'Z$cg^nI4+Ft6u|^jvx^N8m=HinCE!7I6VM;8S2!VYk){wRrhcYAL?p88x|yX3-'
    'u*FjiL;5ZC;)%5P6xH>7CrA9Zq!(S}12GcLv{5I%C7!LU)tOpDG4_(}Tst72iMW3|Yv&?d98hnpn>L5H<8la%rFQlXML&B%j(l6H'
    'b0ju&D%15mjnDz!^<(8wvRQo-IRmv|0rqj0n*oeYH&T}k0cASj$}%}L=Pp>Qw<g@aZKM>GpsDIC!)Xr*vOyH@R(ey!SZd1xyO5$|'
    'O=Xe$GP1|=D(7NlvQrih><8%Spkm*(Pd+V077xO*0f8)*^;X%d%Ue&0LTOjul+gT<v*7MD7(xU?u1cOY><yqd*fF2xBF4pY<#hXc'
    'Xkpc99=b~}XwDhwU+k>W7XH|RuPg5GTUqIxi!zIYm<1JS(njXuaifn1_WP>9%zB5cqblJDSZARQ3J0k0qduNZhjn!!FLph^LFB*X'
    'KW7$ke*#o-'
    '6+S_uor!nZ0OZre2~!_OZ4x<=1e^s$3}Dyf^MLIVY8_)Sbc|M2TUbK#4axcr>_9aTJtMHf|3dhzPQZ>fuXmYDzACN8{-'
    'G&!$#t>?vfk-~-'
    'ES{CI(GJE`d&}=oaK!)cuAnBi8c5%<1<ZlEKq8xfxve~Yhj!CRK9E&Z3!WPZw772^Bax$1AK<3^LBr=|_yT0WZ)A2z&ktA<2q145'
    'W7ERGk=}AXAtbS``@=1|i1tBlrghi3o3NX?SUw-Pw>)t%&{;_+mcsIQAZw71{7EeOZOTGIx{_&ZoFaPA0+aq~a$nW{l&tF*j#4Wk'
    'Qkvs?7+CvwvSn*Yo;iOsl;G9`ErMsj2<<>*J_9x%yC7RpKZ2R!Yp-29cdzE`F-'
    '=ejAk^0U)F+O(Jz2AI$^hkO4%U3=5(mTC&wY+1A^1}5?C$2r`(eJ6p9(?{lPv!T!PJQOiZyi{2^e@-EI{4U%*KRO}e)#&U#@U-'
    'E?>TVA7cSXb+Wq(a{XaYPmG>?>c<0a)XO7%_^|6b#+i%`}$DSR7r+nk8SMGl3<$wL;i9?5P`Qp?2zy8^G&UpE<yKh)}^ytLWu8ZE'
    '-y8E=<Ke%!4A1?pXO>0*EuKL3HiJPk-t8q6!bHfSizN>%v)ZqCm`))qt-'
    ')DaG(c2C^eB`!$_kC&bvSUlGTlVc!>n9GrceuF!ts^6k?SApVv&a0KP1F9(Ro~TLdhoA3U%UNNOP*V~Z_fo&L;t<>`FEfE^}&yyI'
    'Nm(?NaLm}x92``^y-f-d)7IpF!I0r)5j0_pI<S(<@js+{QgU?{nZuAK6KV?-'
    'aj9;R<hv0*q$TXpLBlvmG2xs{j}@vx^vk%^~axj;PKPX?R)O~6Q4NkJ@c$TUwg-~O5go2t{gb!g1viR|LM$m-'
    'r67c7T+4a_29h^_ndq9%6~XR4-CGs^Z5SYJnh!q>)-'
    'yx`Fu^NXwzGN{D%N~6_kH0NdD#|uqrk?+;#Y$*!aC$cc)uk_6^JN7=0=K2Msdy;Q'
)


def encrypt_type1(plain, seed):
    encrypted = bytearray()
    for value in b"\0\0\0\0" + plain:
        byte = value ^ (seed >> 8)
        encrypted.append(byte)
        seed = ((byte + seed) * 52845 + 22719) & 65535
    return bytes(encrypted)


def set_font_program(font, header, plain):
    encrypted = encrypt_type1(plain, 55665)
    font["/FontDescriptor"]["/FontFile"] = Stream(header + encrypted, **{"/Length1": len(header), "/Length2": len(encrypted)})


def get_font_program(font):
    stream = font["/FontDescriptor"]["/FontFile"]
    position = stream["/Length1"]
    return stream.data[:position], _type1_decrypt(stream.data[position:], 55665)


def source_font():
    font = {
        "/Subtype": "/Type1",
        "/BaseFont": "/ABCDEF+bbding",
        "/ToUnicode": Stream(b"0 beginbfchar\nendbfchar\n0 beginbfrange\nendbfrange"),
        "/FontDescriptor": {},
    }
    header, plain = zlib.decompress(base64.b85decode(_FONT_PROGRAM)).split(b"FIXTURE_SEPARATOR")
    set_font_program(font, header, plain)
    return font


class SourceGlyphRecoveryTests(unittest.TestCase):
    def test_recovers_verified_embedded_slots(self):
        self.assertEqual(_verified_symbol_encoding(source_font()), {34: "✔", 37: "✘"})

    def test_later_effective_encoding_assignment_is_rejected(self):
        for replacement in (b"dup 34 /enc-35 put", b"dup 34 /enc-34 put"):
            font = source_font()
            header, plain = get_font_program(font)
            header = header.replace(b"dup 34 /enc-34 put", b"dup 34 /enc-34 put\n" + replacement)
            set_font_program(font, header, plain)
            self.assertEqual(_verified_symbol_encoding(font), {})

    def test_swapped_glyph_program_cannot_become_a_checkmark(self):
        font = source_font()
        header, plain = get_font_program(font)
        check = re.search(rb"/enc-34 (\d+) RD ", plain)
        cross = re.search(rb"/enc-37 (\d+) RD ", plain)
        cross_code = plain[cross.end():cross.end() + int(cross[1])]
        plain = (plain[:check.start()] + f"/enc-34 {len(cross_code)} RD ".encode() + cross_code
                 + plain[check.end() + int(check[1]):])
        set_font_program(font, header, plain)
        self.assertEqual(_verified_symbol_encoding(font), {37: "✘"})

    def test_arbitrary_outlines_under_known_glyph_name_are_rejected(self):
        font = source_font()
        header, plain = get_font_program(font)
        check = re.search(rb"/enc-34 (\d+) RD ", plain)
        # A self-contained Type1 width/endchar program draws no checkmark.
        code = encrypt_type1(bytes([139, 248, 136, 13, 14]), 4330)
        plain = (plain[:check.start()] + f"/enc-34 {len(code)} RD ".encode() + code
                 + plain[check.end() + int(check[1]):])
        set_font_program(font, header, plain)
        self.assertEqual(_verified_symbol_encoding(font), {37: "✘"})

    def test_changed_font_transform_or_private_program_is_rejected(self):
        for part in ("header", "private"):
            font = source_font()
            header, plain = get_font_program(font)
            if part == "header":
                header = header.replace(b"[0.001 0 0 0.001", b"[-0.001 0 0 0.001")
            else:
                plain = plain.replace(b"/RD{string", b"/RD{pop string", 1)
            set_font_program(font, header, plain)
            self.assertEqual(_verified_symbol_encoding(font), {})

    def test_duplicate_charstring_assignment_is_rejected(self):
        font = source_font()
        header, plain = get_font_program(font)
        check = re.search(rb"/enc-34 (\d+) RD ", plain)
        definition_end = check.end() + int(check[1]) + len(b" ND\n")
        plain = plain.replace(b"/CharStrings 3 dict", b"/CharStrings 4 dict")
        plain = plain[:definition_end] + plain[check.start():definition_end] + plain[definition_end:]
        set_font_program(font, header, plain)
        self.assertEqual(_verified_symbol_encoding(font), {})

    def test_unattested_font_trailer_is_rejected(self):
        font = source_font()
        stream = font["/FontDescriptor"]["/FontFile"]
        stream.data += b"/FontMatrix [-1 0 0 1 0 0] def"
        self.assertEqual(_verified_symbol_encoding(font), {})

    def test_same_ascii_in_ordinary_font_is_untouched(self):
        font = source_font()
        font["/BaseFont"] = "/ABCDEF+Times-Roman"
        self.assertEqual(_verified_symbol_encoding(font), {})

    def test_missing_program_and_custom_pdf_encoding_are_not_guessed(self):
        font = source_font()
        del font["/FontDescriptor"]
        self.assertEqual(_verified_symbol_encoding(font), {})
        font = source_font()
        font["/Encoding"] = {"/Differences": [34, "/quotedbl"]}
        self.assertEqual(_verified_symbol_encoding(font), {})

    def test_existing_unicode_map_is_authoritative(self):
        for cmap in (b"1 beginbfchar\n<22> <2714>\nendbfchar", b"01 beginbfchar\n<25> <0022>\nendbfchar", b"1 beginbfrange\n<22> <25> <0022>\nendbfrange", b"/OtherMap usecmap"):
            font = source_font()
            font["/ToUnicode"] = Stream(cmap)
            self.assertEqual(_verified_symbol_encoding(font), {})

    def test_unknown_or_reassigned_embedded_slots_are_not_guessed(self):
        font = source_font()
        font["/FontDescriptor"]["/FontFile"] = Stream(
            b"/FontName /ABCDEF+bbding def\ndup 34 /enc-35 put\ndup 99 /enc-99 put\ncurrentfile eexec"
        )
        self.assertEqual(_verified_symbol_encoding(font), {})

    def test_replaces_blank_preserving_layout_and_style(self):
        original = Char(" ", 10, 20, 15, 26, "/ABCDEF+bbding", True)
        chars, blanks = [], [original]
        _merge_recovered_glyph(chars, blanks, Char("✔", 10.01, 20.01, 15.01, 26.01, "bbding"))
        self.assertEqual(chars, [original])
        self.assertEqual(blanks, [])
        self.assertEqual((original.text, original.l, original.font, original.superscript), ("✔", 10, "/ABCDEF+bbding", True))

    def test_replaces_wrong_glyph_without_duplicate(self):
        original = Char('"', 10, 20, 15, 26, "/ABCDEF+bbding")
        chars = [original]
        recovered = Char("✔", 10, 20, 15, 26, "bbding")
        _merge_recovered_glyph(chars, [], recovered)
        _merge_recovered_glyph(chars, [], recovered)
        self.assertEqual(len(chars), 1)
        self.assertEqual(original.text, "✔")

    def test_does_not_replace_other_font_or_neighboring_glyph(self):
        original = Char('"', 10, 20, 15, 26, "Times-Roman")
        neighbor = Char('"', 30, 20, 35, 26, "bbding")
        chars = [original, neighbor]
        _merge_recovered_glyph(chars, [], Char("✔", 10, 20, 15, 26, "bbding"))
        self.assertEqual(len(chars), 3)
        self.assertEqual(original.text, '"')
        self.assertEqual(neighbor.text, '"')


class SourceMathScriptTests(unittest.TestCase):
    box = {"x": 0, "y": 0, "width": 1, "height": 1}

    def page(self, chars):
        page = PageText(1, 200, 200, chars)
        line = Line(chars, 50)
        line.finalize()
        page._lines = [line]
        return page

    def test_math_subscript_is_retained_with_exact_offset(self):
        page = self.page([Char("C", 10, 50, 16, 60, "CMMI10"), Char("i", 16, 49, 19, 56, "CMMI7")])
        self.assertEqual(page.style_runs(self.box, "Ci"), [{"start": 1, "end": 2, "verticalAlign": "subscript"}])

    def test_lowered_run_is_attached_without_mutating_page_lines(self):
        page = PageText(1, 200, 200, [Char("C", 10, 50, 16, 60, "CMMI10"), Char("i", 16, 48, 19, 55, "CMMI7")])
        self.assertEqual([line.text for line in page.lines], ["C", "i"])
        self.assertEqual(page.script_runs(self.box, "Ci"), [{"start": 1, "end": 2, "verticalAlign": "subscript"}])
        self.assertEqual([line.text for line in page.lines], ["C", "i"])

    def test_lowered_run_does_not_join_a_neighboring_text_line(self):
        for x, b, font in [(16, 39, "CMMI7"), (40, 48, "CMMI7"), (16, 48, "CMR10")]:
            page = PageText(1, 200, 200, [Char("C", 10, 50, 16, 60, font), Char("i", x, b, x + 3, b + 7, "CMMI7")])
            self.assertEqual(page.script_runs(self.box, "Ci"), [])

    def test_multichar_exponent_is_one_run(self):
        page = self.page([Char("n", 10, 50, 16, 60, "CMMI10"), Char("−", 16, 54, 20, 61, "CMSY7"), Char("1", 20, 54, 23, 61, "CMR7")])
        self.assertEqual(page.script_runs(self.box, "n−1"), [{"start": 1, "end": 3, "verticalAlign": "superscript"}])

    def test_prose_note_and_small_same_baseline_glyph_are_not_math(self):
        page = self.page([Char("word", 10, 50, 30, 60, "CMR10"), Char("1", 30, 54, 33, 61, "CMR7")])
        self.assertEqual(page.script_runs(self.box, "word1"), [])
        page = self.page([Char("C", 10, 50, 16, 60, "CMMI10"), Char("i", 16, 50, 19, 57, "CMMI7")])
        self.assertEqual(page.script_runs(self.box, "Ci"), [])

    def test_unmatched_line_cannot_style_an_unrelated_token(self):
        page = self.page([Char("C", 10, 50, 16, 60, "CMMI10"), Char("i", 16, 49, 19, 56, "CMMI7"), Char("other", 22, 50, 50, 60, "CMR10")])
        self.assertEqual(page.script_runs(self.box, "Ci elsewhere"), [])

    def test_ligature_and_whitespace_alignment_preserves_target_offsets(self):
        page = self.page([Char("ﬁ", 0, 50, 7, 60, "CMR10"), Char("C", 10, 50, 16, 60, "CMMI10"), Char("i", 16, 49, 19, 56, "CMMI7")])
        self.assertEqual(page.script_runs(self.box, "fi Ci"), [{"start": 4, "end": 5, "verticalAlign": "subscript"}])


if __name__ == "__main__":
    unittest.main()
